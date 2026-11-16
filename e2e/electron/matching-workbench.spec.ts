import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";

const review = (page: Page) => page.locator('[data-testid="matching-workspace"]:visible');
const sessions = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
const project = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetProject());
async function execute(page: Page) {
  return page.evaluate(async () => {
    const w = window as any, p = w.__dwhE2eGetProject();
    const reply = await w.dwh.invoke("preview_workspace", { workspace: { ...p.workspace, focus_query_id: "dirty_exact_pair" }, connections: p.connections,
      sources: p.sources, projectFile: p.root_path, projectUid: p.project_uid, rowLimit: 100 });
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    return reply.result;
  });
}
async function openMatching(page: Page) {
  await page.getByText("dirty_exact_pair", { exact: true }).first().click();
  await page.locator('[data-step-type="Join"] > [role="button"]').click();
  const lens = page.getByRole("button", { name: "Join Lens", exact: true });
  if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
  const intro = page.getByRole("button", { name: "Got it", exact: true });
  if (await intro.isVisible()) await intro.click();
  await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
  await page.getByTestId("join-lens-no-match").click();
  await page.getByRole("button", { name: "Find Matches", exact: true }).click();
  await review(page).getByTestId("matching-apply-plan").click();
  await expect.poll(async () => (await sessions(page))[0]?.proposals.length).toBeGreaterThan(0);
}
async function focusGermanTarget(page: Page) {
  const browser = review(page).getByRole("region", { name: "RIGHT relationship explorer" });
  await browser.getByRole("searchbox", { name: "Search acquired targets" }).fill("ComputerParts LLC");
  await browser.getByTestId("matching-browse-target").filter({ has: page.getByText("DE", { exact: true }) }).click();
  return browser;
}

async function captureWorkbenchEvidence(page: Page) {
  const dir = path.resolve("test-results/adr0052-matching-workbench");
  fs.mkdirSync(dir, { recursive: true });
  for (const [width, height] of [[1440, 900], [1700, 1200], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: path.join(dir, `left-review-${width}x${height}.png`), animations: "disabled" });
    const browser = review(page).getByRole("region", { name: "RIGHT relationship explorer" });
    await browser.getByRole("searchbox", { name: "Search acquired targets" }).fill("ComputerParts LLC");
    const item = browser.getByTestId("matching-browse-target").first();
    if (await item.count()) {
      await item.click();
      await page.screenshot({ path: path.join(dir, `right-focus-${width}x${height}.png`), animations: "disabled" });
      await review(page).getByRole("button", { name: "Return to LEFT review", exact: true }).click();
    }
    await browser.getByRole("searchbox", { name: "Search acquired targets" }).fill("");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("existing vendor Help Lab: sequential review, unified reverse evidence, real Host counts, atomic write and cold reopen", async () => {
  let app: Awaited<ReturnType<typeof launchApp>> = await launchIsolatedSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-workbench-"));
  try {
    let page = app.page;
    await page.setViewportSize({ width: 1700, height: 1200 });
    await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
    const catalog = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"));
    const title = catalog.find((c: any) => c.id === "name_region_match").title;
    await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).getByRole("button", { name: "Open lab", exact: true }).click();
    await openMatching(page);
    await captureWorkbenchEvidence(page);
    const originalSeed = (await project(page)).workspace.key_maps.find((m: any) => m.id === "map_pos_to_vendor");
    expect(originalSeed).toBeDefined();
    const before = (await project(page)).workspace;
    const baseline = await execute(page);
    const source = ["CPC LLC", "Germany"];
    const row = review(page).getByTestId(`matching-row-${JSON.stringify(source)}`);
    await row.click();
    await review(page).getByRole("button", { name: "Select suggested candidate" }).click();
    // Explicit pick is not confirmation, and sequential navigation preserves it.
    expect((await sessions(page))[0].decisions).toEqual([]);
    await review(page).getByRole("button", { name: "Next unresolved", exact: true }).click();
    await review(page).getByRole("button", { name: "Previous unresolved", exact: true }).click();
    expect((await sessions(page))[0].decisions).toEqual([]);
    let browser = await focusGermanTarget(page);
    const relatedLeft = review(page).getByRole("region", { name: "LEFT records related to selected RIGHT" });
    await browser.getByText(/Evidence & Coverage/).click();
    await expect(browser.getByRole("region", { name: "Relationship authority coverage" })).toContainText("No compatible Mapping selected");
    await browser.getByTestId("matching-inspect-join").click();
    await expect(browser).toContainText("2 LEFT input rows · 1 RIGHT input rows · 2 result rows");
    await expect(relatedLeft.getByRole("list", { name: "Unified related LEFT records" })).toHaveCount(1);
    await expect(relatedLeft).toContainText("executed values, not recovered original aliases");
    expect((await sessions(page))[0].decisions).toEqual([]);
    const related = relatedLeft.getByRole("listitem").filter({ hasText: "CPC LLC" });
    await related.getByRole("button", { name: "Investigate this source (no decision)" }).click();
    await review(page).getByRole("button", { name: "Select this relationship for inspection", exact: true }).click();
    expect((await sessions(page))[0].decisions).toEqual([]);
    await review(page).getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
    expect((await sessions(page))[0].decisions).toHaveLength(1);
    await expect(related).toContainText("Confirmed draft");
    await review(page).getByRole("button", { name: "Undo decision", exact: true }).click();
    expect((await sessions(page))[0].decisions).toEqual([]);
    await review(page).getByRole("button", { name: "Select this relationship for inspection", exact: true }).click();
    await review(page).getByRole("checkbox", { name: "Advance after confirm", exact: true }).check();
    await review(page).getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
    expect((await sessions(page))[0].selectedProposalId).not.toBe(JSON.stringify(source));
    expect((await project(page)).workspace).toEqual(before);
    await review(page).getByTestId("matching-save").click();
    await expect(review(page).getByRole("region", { name: "Matching commit receipt" })).toBeVisible();
    const written = await project(page);
    expect(written.workspace.key_maps.find((m: any) => m.id === "map_pos_to_vendor")).toEqual(originalSeed);
    const map = written.workspace.key_maps.find((m: any) => m.id !== originalSeed.id);
    expect(map.entries.map((e: any) => e.output_values)).toContainEqual(["ComputerParts LLC", "DE"]);
    const after = await execute(page);
    const invoice = (result: any, id: string, column: string) => result.rows.find((r: any[]) => r[result.columns.findIndex((c: any) => c.name === "invoice_id")] === id)?.[result.columns.findIndex((c: any) => c.name === column)];
    expect(invoice(baseline, "i5", "vendor_id")).toBeNull();
    expect(invoice(after, "i5", "vendor_id")).toBe("V11");
    const saved = path.join(dir, "vendor.dwhproj.json");
    await review(page).getByRole("button", { name: "Refresh remaining review", exact: true }).click();
    await expect.poll(async () => (await sessions(page))[0]?.proposals.length).toBeGreaterThan(0);
    browser = await focusGermanTarget(page);
    const nextRelatedLeft = review(page).getByRole("region", { name: "LEFT records related to selected RIGHT" });
    const savedAlias = nextRelatedLeft.getByRole("listitem").filter({ hasText: "CPC LLC" });
    await expect(savedAlias).toContainText("Existing Mapping");
    await expect(savedAlias).toContainText("outside this run — read-only");
    const nextAlias = nextRelatedLeft.getByRole("listitem").filter({ hasText: "Federal Republic of Germany" });
    await nextAlias.getByRole("button", { name: "Investigate this source (no decision)" }).click();
    await review(page).getByRole("button", { name: "Select this relationship for inspection", exact: true }).click();
    await review(page).getByRole("checkbox", { name: "Advance after confirm", exact: true }).uncheck();
    await review(page).getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
    await expect(nextAlias).toContainText("Confirmed draft");
    await expect(savedAlias).toContainText("Existing Mapping");
    // Draft is intentionally not persisted. Only the acknowledged first write survives.
    // First Save changes project-relative execution context, so do it after remaining review.
    await page.evaluate(p => (window as any).__dwhE2eSaveProject(p), saved);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: /^Close Matching:/ }).click();
    await expect.poll(() => sessions(page)).toEqual([]);
    await closeIsolatedSession(app); app = await launchApp(); page = app.page;
    await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), saved);
    await expect.poll(async () => (await project(page)).root_path).toBe(saved);
    expect((await project(page)).workspace.key_maps).toEqual(written.workspace.key_maps);
    const canonicalRows = (rows: unknown[][]) => rows.map(r => JSON.stringify(r)).sort();
    expect(canonicalRows((await execute(page)).rows)).toEqual(canonicalRows(after.rows));
    expect(await sessions(page)).toEqual([]);
  } finally {
    await app.page.evaluate(() => { const w = window as any; for (const s of w.__dwhE2eGetMatchingSessions()) w.__dwhE2eOpenMatchingSession({ ...s, hasUnsavedDecisions: false }); }).catch(() => {});
    await closeIsolatedSession(app); fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function setupInspection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-reverse-inspection-"));
  const left = path.join(dir, "left.csv"), right = path.join(dir, "right.csv");
  fs.writeFileSync(left, "row_id,vendor_label,region\n" + Array.from({ length: 60 }, (_, i) => `${i},Acme,DE`).join("\n") + "\n60,Acme Ltd,DE\n61,Beacon Ltd,US\n");
  fs.writeFileSync(right, "vendor_id,vendor_name,region\nid1,Acme,DE\nid2,Acme,DE\nid3,Beacon,US\n");
  const p = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
  p.workspace = { focus_query_id: "dirty_exact_pair", key_maps: [], queries: [
    { id: "dirty_exact_pair", name: "dirty_exact_pair", execution: "local", steps: [{ type: "LoadCsv", payload: { path: left } },
      { type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: ["vendor_label", "region"], right_on: ["vendor_name", "region"] } }] },
    { id: "dim", name: "dim", execution: "local", steps: [{ type: "LoadCsv", payload: { path: right } }] },
  ] };
  const input = path.join(dir, "input.dwhproj.json"); fs.writeFileSync(input, JSON.stringify(p));
  const app = await launchApp(); const page = app.page;
  await page.setViewportSize({ width: 1700, height: 1200 });
  await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
  await expect(page.getByRole("heading", { name: "dirty_exact_pair", exact: true })).toBeVisible();
  await openMatching(page);
  const browser = review(page).getByRole("region", { name: "RIGHT relationship explorer" });
  await browser.getByTestId("matching-browse-target").filter({ hasText: "Acme" }).click();
  return { app, page, browser, dir, input };
}

test("actual reverse inspection keeps full row counts separate from 50-row samples and renderer suggestions", async () => {
  const { app, page, browser, dir } = await setupInspection();
  try {
    const before = (await project(page)).workspace;
    await expect(browser).toContainText("Actual JOIN: not inspected");
    await browser.getByTestId("matching-inspect-join").click();
    await browser.getByText(/Evidence & Coverage/).click();
    await expect(browser).toContainText("60 LEFT input rows · 2 RIGHT input rows · 120 result rows");
    await expect(browser).toContainText("Showing 50/60 LEFT input rows; sample limit 50");
    await expect(browser).toContainText("Complete arbitrary-large reverse enumeration unsupported");
    const relatedLeft = review(page).getByRole("region", { name: "LEFT records related to selected RIGHT" });
    const list = relatedLeft.getByRole("list", { name: "Unified related LEFT records" });
    await expect(list).toHaveCount(1);
    await expect(list).toContainText("50 displayed input rows");
    await browser.getByRole("combobox", { name: "Relationship provenance" }).selectOption("Actual JOIN");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).not.toContainText("Investigate this source");
    expect((await sessions(page))[0].decisions).toEqual([]);
    expect((await project(page)).workspace).toEqual(before);
  } finally { await closeIsolatedSession(app); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const mutation of ["focus-aba", "context-aba", "project-aba", "close"] as const) {
  test(`real executed reverse reply after ${mutation} cannot install evidence, decide, or publish`, async () => {
    const { app, page, browser, dir, input } = await setupInspection();
    try {
      const before = (await project(page)).workspace;
      await app.app.evaluate(({ ipcMain }) => {
        const w = globalThis as any;
        const original = (ipcMain as any)._invokeHandlers.get("dwh:invoke");
        w.reverseHeld = false; w.reverseSettled = false;
        const hold = new Promise<void>(resolve => { w.releaseReverse = resolve; });
        ipcMain.removeHandler("dwh:invoke");
        ipcMain.handle("dwh:invoke", async (event, cmd, ...args) => {
          const result = await original(event, cmd, ...args);
          if (cmd === "explain_join_key") { w.reverseHeld = true; await hold; w.reverseSettled = true; }
          return result;
        });
      });
      await browser.getByTestId("matching-inspect-join").click();
      await expect.poll(() => app.app.evaluate(() => (globalThis as any).reverseHeld)).toBe(true);
      if (mutation === "focus-aba") {
        await browser.locator("details").evaluate(el => { (el as HTMLDetailsElement).open = true; });
        await browser.getByTestId("matching-browse-target").filter({ hasText: "Beacon" }).click();
        await browser.getByTestId("matching-browse-target").filter({ hasText: "Acme" }).click();
      } else if (mutation === "context-aba") {
        await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: { ...p.workspace,
          queries: p.workspace.queries.map((q: any) => q.id === "dirty_exact_pair" ? { ...q, steps: [q.steps[0], { type: "Filter", payload: { condition: "true" } }, ...q.steps.slice(1)] } : q) } })));
        await expect.poll(async () => (await sessions(page))[0]?.commitLifecycle?.status).toBe("stale");
        await page.evaluate(ws => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: ws })), before);
      } else if (mutation === "project-aba") {
        await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
        await expect.poll(() => sessions(page)).toEqual([]);
      } else {
        await page.getByRole("button", { name: /^Close Matching:/ }).click();
        await expect.poll(() => sessions(page)).toEqual([]);
      }
      await app.app.evaluate(() => (globalThis as any).releaseReverse());
      await expect.poll(() => app.app.evaluate(() => (globalThis as any).reverseSettled)).toBe(true);
      if (mutation === "close" || mutation === "project-aba") await expect(review(page)).toHaveCount(0);
      else await expect(review(page)).not.toContainText("60 LEFT input rows");
      expect((await sessions(page)).flatMap((s: any) => s.decisions)).toEqual([]);
      expect((await project(page)).workspace).toEqual(before);
      if (mutation === "focus-aba") {
        await expect(browser).toContainText("Actual JOIN: not inspected");
        await browser.getByTestId("matching-inspect-join").click();
        await expect(browser).toContainText("60 LEFT input rows");
      }
    } finally {
      await app.app.evaluate(() => (globalThis as any).releaseReverse?.()).catch(() => {});
      await closeIsolatedSession(app); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
