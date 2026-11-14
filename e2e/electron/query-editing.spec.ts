import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";

let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
test.beforeEach(async () => {
  session = await launchIsolatedSession();
  await session.page.setViewportSize({ width: 1600, height: 1000 });
});
test.afterEach(async () => { await closeIsolatedSession(session); });

const project = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetProject());
const selected = (page: Page, index: number) =>
  expect(page.locator(`[data-step-index="${index}"] > [role="button"]`)).toHaveAttribute("aria-current", "step");

async function connect(page: Page, right: string, host: string) {
  const source = page.locator(`.react-flow__node[data-id="${right}"] .react-flow__handle.source`);
  const target = page.locator(`.react-flow__node[data-id="${host}"] .react-flow__handle.target`);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  // Viewport resize starts React Flow fitView animation. Wait for actionability
  // before taking coordinates; visible alone does not mean handles are stable.
  await target.hover();
  await source.hover();
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error("Visible Query handles have no bounds");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("canvas JOIN append and upsert select the actual committed JOIN, not a stale updater index", async ({}, info) => {
  const { page } = session;
  await connect(page, "catalog_wide", "supplier_products");
  await page.screenshot({ path: info.outputPath("join-after-connect.png") });
  await expect.poll(async () => (await project(page)).workspace.queries[0].steps.length).toBe(3);
  await selected(page, 2);
  await expect(page.getByTestId("query-step-editor").locator("select").first()).toHaveValue("catalog_wide");
  const first = (await project(page)).workspace.queries[0].steps[2];
  expect(first.type).toBe("Join");
  expect(first.payload.left_on).toEqual([]); // Distinct schemas: no invented key.
  expect(first.payload.right_on).toEqual([]);

  // Set up a non-final existing JOIN, then use the real canvas upsert again.
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
    workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) =>
      q.id !== "supplier_products" ? q : { ...q, steps: [
        ...q.steps.slice(0, 2),
        { type: "Join", payload: { ...q.steps[2].payload, join_type: "full" } },
        { type: "Filter", payload: { condition: "true" } },
      ] }) },
  })));
  await page.locator('[data-step-index="3"] > [role="button"]').click();
  await connect(page, "catalog_wide", "supplier_products");
  await selected(page, 2);
  const steps = (await project(page)).workspace.queries[0].steps;
  expect(steps.map((s: any) => s.type)).toEqual(["LoadCsv", "SelectColumns", "Join", "Filter"]);
  expect(steps[2].payload.join_type).toBe("inner");
  await expect(page.getByTestId("query-step-editor").locator("select").filter({
    has: page.locator('option[value="full"]'),
  })).toHaveValue("inner");
});

test("batched append, replace, move and remove use the latest graph and valid selection", async () => {
  const { page } = session;
  // Two real UI commands in one event turn, before React commits either edit.
  await page.evaluate(() => {
    (document.querySelector('button[title="Add Limit"]') as HTMLButtonElement).click();
    (document.querySelector('button[title="Add Filter"]') as HTMLButtonElement).click();
  });
  await selected(page, 3);
  const input = page.getByTestId("query-step-editor").getByPlaceholder("amount > 1000");
  await input.fill("  length(product_name) > 0  ");
  await page.getByTestId("query-step-editor").getByRole("button", { name: "Apply", exact: true }).click();
  await expect(input).toHaveValue("  length(product_name) > 0  ");
  await expect.poll(async () => (await project(page)).workspace.queries[0].steps[3].payload.condition)
    .toBe("length(product_name) > 0");
  await page.locator('[data-step-index="3"]').getByTitle("Move up", { exact: true }).click();
  await selected(page, 2);
  await expect(input).toHaveValue("length(product_name) > 0");
  await expect(page.locator('[data-step-index="0"]').getByTitle("Move down", { exact: true })).toBeDisabled();
  await page.locator('[data-step-index="2"]').getByTitle("Remove", { exact: true }).click();
  await selected(page, 1);
  expect((await project(page)).workspace.queries[0].steps.map((s: any) => s.type))
    .toEqual(["LoadCsv", "SelectColumns", "Limit"]);
  await page.getByTestId("preview-recompute").click();
  await expect(page.getByTestId("preview-scope")).toHaveText("Sample · LIMIT 50");
});

test("canvas deletion scrubs structural dependencies without discarding another queued edit or Mapping", async () => {
  const { page } = session;
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
    workspace: { ...p.workspace, key_maps: [{ id: "keep", name: "Keep", entries: [], storage: { kind: "seed" } }],
      queries: p.workspace.queries.map((q: any) => q.id !== "catalog_products" ? q : {
        ...q, steps: [...q.steps,
          { type: "Join", payload: { right_query_id: "supplier_products", join_type: "left", left_on: [], right_on: [] } },
          { type: "Append", payload: { other_query_ids: ["supplier_products", "catalog_wide"] } }],
      }) },
  })));
  // Append and Delete are batched; deletion must not restore captured old queries.
  await page.evaluate(() => {
    (document.querySelector('button[title="Add Limit"]') as HTMLButtonElement).click();
    const button = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === "Delete");
    if (!button) throw new Error("Canvas Delete unavailable");
    button.click();
  });
  await expect(page.getByRole("heading", { name: "catalog_products", exact: true })).toBeVisible();
  const current = await project(page);
  expect(current.workspace.queries.map((q: any) => q.id)).toEqual(["catalog_products", "catalog_wide"]);
  expect(current.workspace.queries[0].steps.map((s: any) => s.type)).toEqual(["LoadCsv", "SelectColumns", "Append"]);
  expect(current.workspace.queries[0].steps[2].payload.other_query_ids).toEqual(["catalog_wide"]);
  expect(current.workspace.key_maps[0].id).toBe("keep");
  expect(current.workspace.focus_query_id).toBe("catalog_products");
});

test("sequential create/derive/edit/remove round-trips through Save + reopen without losing KeyMaps", async ({}, info) => {
  const { page, fixtureWorkDir } = session;
  const outPath = path.join(fixtureWorkDir, `_e2e_query_editing_${Date.now()}.dwhproj.json`);

  // Seed an unrelated seed Mapping before any Query edit so the round-trip
  // proves unrelated Workspace properties survive create/derive/edit/remove.
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({
    ...p,
    workspace: { ...p.workspace, key_maps: [
      { id: "keep", name: "KeepSeed", entries: [], output_columns: ["id"], storage: { kind: "seed" } },
    ] },
  })));

  // 1) Derive a branch (ref↳) from a specific node, then focus the new branch so
  //    canvas toolbar actions target it.
  await page.locator('[data-id="catalog_wide"] button[title="Branch: new query = FromQuery / dbt ref(this)"]').click();
  await expect.poll(async () => (await project(page)).workspace.queries.length).toBeGreaterThanOrEqual(4);
  const before = await project(page);
  const derivedId = before.workspace.queries.at(-1)!.id;
  await page.locator(`[data-id="${derivedId}"]`).click();

  // 2) Add a JOIN to the derived branch, then a Limit step — exercises edit paths
  //    that both route through the same Query Editing service boundary.
  await connect(page, "supplier_products", derivedId);
  await page.locator('button[title="Add Limit"]').click();
  await expect.poll(async () =>
    (await project(page)).workspace.queries.find((q: any) => q.id === derivedId).steps.length).toBeGreaterThanOrEqual(3);

  // 3) Remove catalog_products; its Join/Append references in surviving Queries are
  //    structurally scrubbed rather than leaving a rootless Query. Focus it first so
  //    the canvas "Delete" toolbar applies to the correct node.
  await page.locator('[data-id="catalog_products"]').click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "catalog_products", exact: true })).toBeHidden();

  const afterDelete = await project(page);
  expect(afterDelete.workspace.queries.map((q: any) => q.id)).not.toContain("catalog_products");
  // Unrelated seed Mapping survived the delete.
  expect(afterDelete.workspace.key_maps?.find((m: any) => m.id === "keep")?.name).toBe("KeepSeed");

  // 4) Save the project to disk (host-written JSON) and confirm the file exists.
  await page.evaluate(async (p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (typeof w.__dwhE2eSaveProject !== "function") throw new Error("__dwhE2eSaveProject missing");
    await w.__dwhE2eSaveProject(p);
  }, outPath);
  await expect
    .poll(() => fs.existsSync(outPath), { timeout: 30_000 })
    .toBe(true);

  // 5) Reopen the saved project and verify the graph and unrelated KeyMap survived.
  await page.evaluate((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__dwhE2eOpenProject(p);
  }, outPath);
  await expect(page.getByText(/Opened /)).toBeVisible({ timeout: 60_000 });

  const reopened = await project(page);
  expect(reopened.workspace.queries.map((q: any) => q.id)).not.toContain("catalog_products");
  expect(reopened.workspace.queries.map((q: any) => q.id)).toContain(derivedId);
  const keepMap = reopened.workspace.key_maps?.find((m: any) => m.id === "keep");
  expect(keepMap?.name).toBe("KeepSeed");

  fs.unlinkSync(outPath);
});
