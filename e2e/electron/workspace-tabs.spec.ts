import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { launchIsolatedSession, closeIsolatedSession } from "./helpers/launch.mjs";
import { emptyMatchingSession } from "../../src/app/matching/types";

let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
test.beforeEach(async () => { session = await launchIsolatedSession(); });
test.afterEach(async () => {
  // Explicit test-only discard: retained dirty Matching must not block beforeunload.
  if (session?.page && !session.page.isClosed()) {
    await session.page.evaluate(() => {
      const w = window as any;
      for (const s of w.__dwhE2eGetMatchingSessions()) {
        w.__dwhE2eOpenMatchingSession({ ...s, hasUnsavedDecisions: false });
      }
    });
    await expect.poll(() => session.page.evaluate(() =>
      (window as any).__dwhE2eGetMatchingSessions().some((s: any) => s.hasUnsavedDecisions))).toBe(false);
  }
  await closeIsolatedSession(session);
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const activeMatching = (page: Page) => page.locator('[aria-hidden="false"]')
  .filter({ has: page.getByTestId("matching-data-origin") });
const drafts = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetMappingDrafts());

async function openMap(id = "canvas", name = "Reserved map") {
  await session.page.evaluate(({ id, name }) => {
    const w = window as any;
    w.__dwhE2ePatchProject((p: any) => ({ ...p, workspace: { ...p.workspace,
      key_maps: [...(p.workspace.key_maps ?? []).filter((m: any) => m.id !== id), {
        id, name, storage: { kind: "seed" }, entries: [{ from: "alpha", to: "one" }],
      }],
    } }));
  }, { id, name });
  await session.page.evaluate((id) => (window as any).__dwhE2eOpenMapping(id), id);
  await expect(tab(session.page, name)).toHaveAttribute("aria-selected", "true");
}

async function openMatching(dirty = false) {
  const matching = emptyMatchingSession({ id: "x", title: "Matching: Tab test", entry: "mapping",
    scope: "cohort", hasUnsavedDecisions: dirty, chatCollapsed: true });
  await session.page.evaluate((s) => (window as any).__dwhE2eOpenMatchingSession(s), matching);
  await expect(tab(session.page, matching.title)).toHaveAttribute("aria-selected", "true");
}

async function requestLab(page: Page) {
  await tab(page, "Help Lab").click();
  const catalog = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"));
  const title = catalog.find((c: any) => c.id === "recon_ship_sales").title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
}

test("reserved-looking Mapping IDs and Matching remain independent; switches retain mounted local state", async () => {
  const { page } = session;
  await openMap();
  const filter = page.locator('input[placeholder="Filter rows…"]:visible');
  await filter.fill("alpha"); // Component-local state, not in the document owner.
  await page.locator('input[data-col="to"]').fill("edited");
  await expect.poll(async () => (await drafts(page))[0].dirty).toBe(true);
  await openMap("help_lab", "Help-shaped map");
  await openMap("matching:x", "Matching-shaped map");
  await openMatching();
  await activeMatching(page).getByTestId("matching-apply-plan").click();
  await expect(activeMatching(page).getByText(/Live matching unavailable:/)).toHaveCount(2);
  await tab(page, "Pipeline canvas").click();
  await expect(tab(page, "Pipeline canvas")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Help Lab").click();
  await expect(page.getByRole("heading", { name: "Learn by finishing a job" })).toBeVisible();
  await tab(page, "Reserved map").click();
  await expect(filter).toHaveValue("alpha");
  await expect(page.locator('input[data-col="to"]:visible')).toHaveValue("edited");
  await tab(page, "Matching: Tab test").click();
  // Error is component-local, so this also detects accidental unmount/remount.
  await expect(activeMatching(page).getByText(/Live matching unavailable:/)).toHaveCount(2);
  await expect(tab(page, "Matching-shaped map")).toHaveAttribute("aria-selected", "false");
  await page.getByRole("button", { name: "Close Matching-shaped map", exact: true }).click();
  await expect(tab(page, "Matching: Tab test")).toHaveAttribute("aria-selected", "true");
  // Reopening an existing map must not duplicate its tab or lose its draft.
  await page.evaluate(() => (window as any).__dwhE2eOpenMapping("canvas"));
  await expect(tab(page, "Reserved map")).toHaveCount(1);
  await expect(page.locator('input[data-col="to"]:visible')).toHaveValue("edited");
});

test("dirty Mapping close cancellation preserves draft; discard and Escape use Mapping neighbor then canvas", async () => {
  const { page } = session;
  await openMap();
  await page.locator('input[data-col="to"]').fill("unsaved");
  await expect.poll(async () => (await drafts(page))[0].dirty).toBe(true);
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Close Reserved map", exact: true }).click();
  await expect(tab(page, "Reserved map")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('input[data-col="to"]')).toHaveValue("unsaved");
  await openMap("second", "Neighbor map");
  await tab(page, "Reserved map").click();
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(tab(page, "Reserved map")).toHaveCount(0);
  await expect(tab(page, "Neighbor map")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close Neighbor map", exact: true }).click();
  await expect(tab(page, "Pipeline canvas")).toHaveAttribute("aria-selected", "true");
});

test("dirty Matching close and keyboard cancellation preserve session; discard returns to canvas", async () => {
  const { page } = session;
  await openMatching(true); // Synthetic dirty lifecycle state, no retrieval/save claim.
  const before = await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Close Matching: Tab test", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions())).toEqual(before);
  await expect(tab(page, "Matching: Tab test")).toHaveAttribute("aria-selected", "true");
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(tab(page, "Matching: Tab test")).toHaveAttribute("aria-selected", "true");
  page.once("dialog", (d) => d.accept());
  await page.keyboard.press("Escape");
  await expect(tab(page, "Matching: Tab test")).toHaveCount(0);
  await expect(tab(page, "Pipeline canvas")).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions())).toEqual([]);
});

test("project replacement Cancel retains dirty tabs; Discard resets owners and keeps Help Lab available", async () => {
  const { page } = session;
  await openMap();
  await page.locator('input[data-col="to"]').fill("keep me");
  await openMatching(true);
  const before = await page.evaluate(() => ({ project: (window as any).__dwhE2eGetProject(),
    matching: (window as any).__dwhE2eGetMatchingSessions(), maps: (window as any).__dwhE2eGetMappingDrafts() }));
  await requestLab(page);
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => ({ project: (window as any).__dwhE2eGetProject(),
    matching: (window as any).__dwhE2eGetMatchingSessions(), maps: (window as any).__dwhE2eGetMappingDrafts() }))).toEqual(before);
  await expect(tab(page, "Help Lab")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Reserved map").click();
  await expect(page.locator('input[data-col="to"]')).toHaveValue("keep me");
  await requestLab(page);
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(tab(page, "Reserved map")).toHaveCount(0);
  await expect(tab(page, "Matching: Tab test")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions().length)).toBe(0);
  expect(await drafts(page)).toEqual([]);
  await expect(tab(page, "Pipeline canvas")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Help Lab").click();
  await expect(page.getByRole("heading", { name: "Learn by finishing a job" })).toBeVisible();
});

test("quality service switches independently and project replacement clears its availability", async () => {
  const { page } = session;
  await tab(page, "Help Lab").click();
  const catalog = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"));
  const title = catalog.find((c: any) => c.id === "mapping_quality").title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
  const quality = page.getByRole("tab", { name: /Mapping quality/ });
  await expect(quality).toHaveAttribute("aria-selected", "true");
  await openMap("quality", "Quality-shaped map");
  await quality.click();
  await expect(quality).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Quality-shaped map")).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Escape");
  await expect(tab(page, "Pipeline canvas")).toHaveAttribute("aria-selected", "true");
  await requestLab(page);
  await page.getByRole("dialog", { name: "Save changes before switching projects?" })
    .getByRole("button", { name: "Discard", exact: true }).click();
  await expect(quality).toHaveCount(0);
  await expect(tab(page, "Quality-shaped map")).toHaveCount(0);
  await expect(tab(page, "Help Lab")).toBeVisible();
});
