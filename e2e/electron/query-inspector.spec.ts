import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";
import { emptyMatchingSession } from "../../src/app/matching/types";

let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
test.beforeEach(async () => { session = await launchIsolatedSession(); });
test.afterEach(async () => {
  if (session?.page && !session.page.isClosed()) {
    // Discard only after assertions; dirty Matching otherwise blocks app.close.
    await session.page.evaluate(() => {
      const w = window as any;
      w.__dwhE2eReleaseDescribeHold();
      for (const draft of w.__dwhE2eGetMatchingSessions())
        w.__dwhE2eOpenMatchingSession({ ...draft, hasUnsavedDecisions: false });
    });
    await expect.poll(() => session.page.evaluate(() =>
      (window as any).__dwhE2eGetMatchingSessions().some((s: any) => s.hasUnsavedDecisions))).toBe(false);
  }
  await closeIsolatedSession(session);
});

const editor = (page: Page) => page.getByTestId("query-step-editor");
async function selectQuery(page: Page, id: string) {
  await page.getByText(id, { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
}
async function selectStep(page: Page, index: number) {
  await page.locator(`[data-step-index="${index}"] > [role="button"]`).click();
}
const project = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetProject());
async function configureTextSteps(page: Page) {
  await selectQuery(page, "catalog_wide");
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
    workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) => q.id === "catalog_wide" ? q : {
      ...q, steps: [q.steps[0],
        { type: "Filter", payload: { condition: q.id === "supplier_products" ? "true" : "false" } },
        { type: "Filter", payload: { condition: "1 = 1" } }],
    }) },
  })));
}
async function requestLab(page: Page) {
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  const title = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"))
    .find((lab: any) => lab.id === "recon_ship_sales").title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
}

test("same-kind step/query navigation hydrates only that target; Apply retains exact Filter input", async () => {
  const { page } = session;
  await configureTextSteps(page);
  const focus = (await project(page)).workspace.focus_query_id;
  await selectQuery(page, "supplier_products");
  await selectStep(page, 1);
  const input = editor(page).getByPlaceholder("amount > 1000");
  await expect(input).toHaveValue("true");
  await input.fill("uncommitted old step");
  await selectStep(page, 2);
  await expect(input).toHaveValue("1 = 1");
  await selectQuery(page, "catalog_products");
  await selectStep(page, 1);
  await expect(input).toHaveValue("false");
  await selectQuery(page, "supplier_products");
  await selectStep(page, 1);
  await expect(input).toHaveValue("true");
  const raw = "  length(product_name) > 0  ";
  await input.fill(raw);
  await input.press("Enter");
  await expect(input).toHaveValue(raw);
  await expect.poll(async () => (await project(page)).workspace.queries[0].steps[1].payload.condition)
    .toBe(raw.trim());
  await expect(page.getByTestId("preview-recompute")).toBeEnabled();
  await page.getByTestId("preview-recompute").click();
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
  await expect(input).toHaveValue(raw);
  expect((await project(page)).workspace.focus_query_id).toBe(focus);
});

test("GroupBy formatting survives commit, recompute and mounted Mapping/Matching tool navigation", async () => {
  const { page } = session;
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
    workspace: { ...p.workspace, key_maps: [{ id: "draft_map", name: "Draft map", storage: { kind: "seed" }, entries: [] }],
      queries: p.workspace.queries.map((q: any) => q.id !== "supplier_products" ? q : { ...q,
        steps: [q.steps[0], { type: "GroupBy", payload: { dimensions: ["category"], aggregates: ["count(*) as n"] } }] }) },
  })));
  await selectQuery(page, "supplier_products");
  await selectStep(page, 1);
  const dims = editor(page).getByPlaceholder("dimensions: region");
  const aggs = editor(page).getByPlaceholder("sum(qty) as qty");
  await dims.fill("  category  ");
  await aggs.fill(" count(*) as n ,  min(product_name) as first_name ");
  await editor(page).getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dims).toHaveValue("  category  ");
  await expect(aggs).toHaveValue(" count(*) as n ,  min(product_name) as first_name ");
  await expect(page.getByTestId("preview-recompute")).toBeEnabled();
  await page.getByTestId("preview-recompute").click();
  await page.evaluate(() => (window as any).__dwhE2eOpenMapping("draft_map"));
  const matching = emptyMatchingSession({ id: "inspector", title: "Matching: Inspector retention", entry: "mapping",
    scope: "cohort", hasUnsavedDecisions: true, instructionText: "Retain this independent draft" });
  await page.evaluate((draft) => (window as any).__dwhE2eOpenMatchingSession(draft), matching);
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
  await expect(dims).toHaveValue("  category  ");
  await expect(aggs).toHaveValue(" count(*) as n ,  min(product_name) as first_name ");
  expect((await project(page)).workspace.queries[0].steps[1].payload.aggregates)
    .toEqual(["count(*) as n", "min(product_name) as first_name"]);
  await page.screenshot({ path: "docs/stabilization/pr05-inspector-group.png" });
});

test("Fields retains exact text after Apply and late upstream schema choices", async () => {
  const { page } = session;
  await selectQuery(page, "supplier_products");
  await selectStep(page, 0);
  // Existing preview response hold; only the upstream Fields request can claim it on Model.
  await page.getByRole("tab", { name: "Model", exact: true }).click();
  await page.evaluate(() => (window as any).__dwhE2eArmPreviewHold());
  try {
    await selectStep(page, 1);
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
    const input = editor(page).getByPlaceholder("date, region, amount");
    await input.fill(" category ,  product_name  ");
    await editor(page).getByRole("button", { name: "Apply", exact: true }).click();
    await expect(input).toHaveValue(" category ,  product_name  ");
  } finally { await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold()); }
  await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
  await expect(editor(page).getByPlaceholder("date, region, amount")).toHaveValue(" category ,  product_name  ");
  expect((await project(page)).workspace.queries[0].steps[1].payload.columns).toEqual(["category", "product_name"]);
});

test("held Join columns cannot hydrate newer query/step drafts", async () => {
  const { page } = session;
  await selectQuery(page, "catalog_wide");
  await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p,
    workspace: { ...p.workspace, queries: p.workspace.queries.map((q: any) => q.id === "catalog_wide" ? q : { ...q,
      steps: [q.steps[0], { type: "Join", payload: { right_query_id: "catalog_wide", join_type: "left",
        left_on: [q.id === "supplier_products" ? "product_name" : "name"], right_on: ["name"] } },
        { type: "Filter", payload: { condition: "true" } }],
    }) },
  })));
  await page.evaluate(() => (window as any).__dwhE2eArmDescribeHold());
  try {
    await selectQuery(page, "supplier_products");
    await selectStep(page, 1);
    await page.evaluate(() => (window as any).__dwhE2eWaitDescribeStarted());
    await selectStep(page, 2);
    await editor(page).getByPlaceholder("amount > 1000").fill(" 1 = 1 ");
    await selectQuery(page, "catalog_products");
    await selectStep(page, 1);
    const type = editor(page).locator("select").filter({ has: page.locator('option[value="full"]') });
    await type.selectOption("full");
    await expect(type).toHaveValue("full");
  } finally { await page.evaluate(() => (window as any).__dwhE2eReleaseDescribeHold()); }
  await page.evaluate(() => (window as any).__dwhE2eWaitDescribeSettled());
  await expect(editor(page).locator('select[title="This query (before Join)"]').first()).toHaveValue("name");
  await expect(editor(page).locator("select").filter({ has: page.locator('option[value="full"]') })).toHaveValue("full");
  await editor(page).getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await project(page)).workspace.queries[1].steps[1].payload.join_type).toBe("full");
  await page.screenshot({ path: "docs/stabilization/pr05-inspector-join.png" });
});

test("Inspector commit uses real dirty guard and Save; selection keeps export focus until Set focus", async () => {
  const { page, projectPath } = session;
  await configureTextSteps(page);
  await selectQuery(page, "catalog_products");
  await selectStep(page, 1);
  expect((await project(page)).workspace.focus_query_id).toBe("supplier_products");
  await page.getByRole("button", { name: "Set focus", exact: true }).click();
  expect((await project(page)).workspace.focus_query_id).toBe("catalog_products");
  const input = editor(page).getByPlaceholder("amount > 1000");
  await input.fill("  true  ");
  await editor(page).getByRole("button", { name: "Apply", exact: true }).click();
  await requestLab(page);
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("tab", { name: "Pipeline canvas", exact: true }).click();
  await expect(input).toHaveValue("  true  ");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: /^Save ⌘S$/ }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(projectPath, "utf8")).workspace.queries[1].steps[1].payload.condition).toBe("true");
  await expect(input).toHaveValue("  true  ");
  expect(JSON.parse(fs.readFileSync(projectPath, "utf8")).workspace.focus_query_id).toBe("catalog_products");
  // A successful ordinary Save establishes a clean replacement baseline.
  await requestLab(page);
  await expect(page.getByRole("button", { name: "Show me where to start", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
