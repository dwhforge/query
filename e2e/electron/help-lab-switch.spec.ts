import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import type { Project } from "../../src/types/pipeline";
import fs from "node:fs";
import path from "node:path";
import {
  launchIsolatedSession,
  closeIsolatedSession,
} from "./helpers/launch.mjs";

declare global {
  interface Window {
    __dwhE2eGetProject: () => Project;
    __dwhE2ePatchProject: (updater: (p: Project) => Project) => void;
  }
}

async function openReconLab(page: Page) {
  await page.getByRole("tab", { name: "Help Lab", exact: true }).click();
  const catalog = JSON.parse(fs.readFileSync("fixtures/labs/catalog.json", "utf8"));
  const title = catalog.find((c: { id: string }) => c.id === "recon_ship_sales").title;
  await page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })
    .getByRole("button", { name: "Open lab", exact: true }).click();
}

const switchDialog = (page: Page) => page.getByRole("dialog", { name: "Save changes before switching projects?" });
const currentProject = (page: Page) => page.evaluate(() => window.__dwhE2eGetProject());
async function editProject(page: Page, patch: Partial<Project> = {}) {
  await page.evaluate((patch) => window.__dwhE2ePatchProject((p) => ({
    ...p, ...patch,
    workspace: { ...p.workspace, queries: p.workspace.queries.map((q, i) =>
      i === 0 ? { ...q, name: "unsaved_work" } : q) },
  })), patch);
  await expect.poll(async () => (await currentProject(page)).workspace.queries[0].name).toBe("unsaved_work");
}

async function savePicker(app: ElectronApplication, filePath: string | null) {
  await app.evaluate(({ dialog }, filePath) => {
    (globalThis as any).__savePickerCalls = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      (globalThis as any).__savePickerCalls.push(args[args.length - 1]);
      return { canceled: filePath === null, filePath: filePath ?? undefined };
    }) as any;
  }, filePath);
}

async function openPicker(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as any;
  }, filePath);
}

async function fileMenu(page: Page, label: RegExp) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: label }).click();
}

test.describe("safe Help Lab project replacement", () => {
  let session: Awaited<ReturnType<typeof launchIsolatedSession>>;
  test.beforeEach(async () => { session = await launchIsolatedSession(); });
  test.afterEach(async () => { await closeIsolatedSession(session); });

  test("Cancel keeps changed graph, tabs and save target intact", async ({}, testInfo) => {
    const { page, projectPath } = session;
    const bytes = fs.readFileSync(projectPath, "utf8");
    await editProject(page);
    await openReconLab(page);
    const dialog = switchDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const before = await page.evaluate(() => window.__dwhE2eGetProject());
    await page.screenshot({ path: testInfo.outputPath("switch-prompt.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => window.__dwhE2eGetProject())).toEqual(before);
    expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
    await expect(page.getByRole("heading", { name: "Learn by finishing a job" })).toBeVisible();
  });

  test("Discard opens an independent offline lab; Save asks for a new path and reopens", async ({}, testInfo) => {
    const { page, app, projectPath, fixtureWorkDir } = session;
    const bytes = fs.readFileSync(projectPath, "utf8");
    const old = await currentProject(page);
    await editProject(page, { last_dbt_export_path: "/do-not-inherit", outputs: ["catalog_products"],
      mapping_checks: [], mapping_check_runs: [] });
    await openReconLab(page);
    await switchDialog(page).getByRole("button", { name: "Discard", exact: true }).click();
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    const lab = await currentProject(page);
    expect(lab.project_uid).not.toBe(old.project_uid);
    expect(lab.id).not.toBe(old.id);
    expect(lab.root_path).toBeUndefined();
    expect(lab.last_dbt_export_path).toBeUndefined();
    expect(lab.outputs).toEqual([]);
    expect(lab.references).toEqual([]);
    expect(lab.connection_bindings).toEqual([]);
    expect(lab.mapping_checks ?? []).toEqual([]);
    expect(lab.execution_engine).toBe("duckdb");
    expect(lab.destination?.kind).toBe("duckdb");
    expect(lab.workspace.focus_query_id).toBe("dirty_recon");
    expect(lab.workspace.key_maps?.some((m) => m.id === "map_sku")).toBe(true);
    await expect(page.getByRole("heading", { name: "dirty_recon", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("clean-lab.png") });
    expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
    const labPath = path.join(fixtureWorkDir, "saved-lab.dwhproj.json");
    await savePicker(app, labPath);
    await fileMenu(page, /^Save ⌘S$/);
    await expect.poll(() => fs.existsSync(labPath)).toBe(true);
    await expect.poll(async () => (await currentProject(page)).root_path).toBe(labPath);
    const calls = await app.evaluate(() => (globalThis as any).__savePickerCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].defaultPath).not.toContain(path.basename(projectPath));
    expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
    await openPicker(app, labPath);
    await fileMenu(page, /^Open…/);
    await expect(page.getByText(`Opened ${labPath}`, { exact: true })).toBeVisible();
    expect((await currentProject(page)).project_uid).toBe(lab.project_uid);
    expect((await currentProject(page)).workspace.focus_query_id).toBe("dirty_recon");
  });

  test("Save persists changed working project before opening clean lab", async () => {
    const { page, projectPath } = session;
    const uid = (await currentProject(page)).project_uid;
    await editProject(page);
    await openReconLab(page);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    const saved = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    expect(saved.workspace.queries[0].name).toBe("unsaved_work");
    expect(saved.project_uid).toBe(uid);
    expect((await currentProject(page)).root_path).toBeUndefined();
  });

  test("cancelled first-save picker keeps the unsaved project open", async () => {
    const { page, app, projectPath } = session;
    const bytes = fs.readFileSync(projectPath, "utf8");
    await editProject(page, { root_path: undefined });
    await savePicker(app, null);
    await openReconLab(page);
    const before = await currentProject(page);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await app.evaluate(() => (globalThis as any).__savePickerCalls)).length).toBe(1);
    await expect(switchDialog(page)).toBeHidden();
    expect(await currentProject(page)).toEqual(before);
    expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
    // Retry proves that picker cancellation also released the switch guard.
    await openReconLab(page);
    await expect(switchDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(switchDialog(page)).toBeHidden();
    await expect(page.getByRole("heading", { name: "Learn by finishing a job" })).toBeVisible();
  });

  test("first Save writes to the selected file before switching", async () => {
    const { page, app, fixtureWorkDir } = session;
    await editProject(page, { root_path: undefined });
    const selected = path.join(fixtureWorkDir, "first-save.dwhproj.json");
    await savePicker(app, selected);
    await openReconLab(page);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    expect(JSON.parse(fs.readFileSync(selected, "utf8")).workspace.queries[0].name).toBe("unsaved_work");
  });

  test("failed Save leaves the current project intact and permits retry", async () => {
    const { page, app, fixtureWorkDir } = session;
    await editProject(page, { root_path: undefined });
    await savePicker(app, fixtureWorkDir); // A directory is not a writable project file.
    await openReconLab(page);
    const before = await currentProject(page);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Is a directory|os error 21/i).first()).toBeVisible();
    expect(await currentProject(page)).toEqual(before);
    await openReconLab(page);
    await expect(switchDialog(page)).toBeVisible();
    await switchDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("unchanged saved project opens lab without an unsaved warning", async () => {
    const { page } = session;
    await openReconLab(page);
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    await expect(switchDialog(page)).toBeHidden();
  });

  test("Open uses the same Cancel and failed-load protection", async () => {
    const { page, app, fixtureWorkDir } = session;
    await editProject(page);
    const before = await currentProject(page);
    await openPicker(app, path.join(fixtureWorkDir, "missing.dwhproj.json"));
    await fileMenu(page, /^Open…/);
    await expect(switchDialog(page)).toBeVisible();
    await switchDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await currentProject(page)).toEqual(before);
    await fileMenu(page, /^Open…/);
    await switchDialog(page).getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText(/No such file|os error 2/i).first()).toBeVisible();
    // A completed preview must not erase an unrelated project-load failure.
    const recompute = page.getByTestId("preview-recompute");
    // Check enabled, arm and dispatch atomically: a prior toBeEnabled assertion
    // can race a scheduled preview render and .click() on disabled does nothing.
    await expect.poll(() => recompute.evaluate((button: HTMLElement) => {
      if ((button as HTMLButtonElement).disabled) return false;
      (window as any).__dwhE2eArmPreviewHold();
      (button as HTMLButtonElement).click();
      return true;
    })).toBe(true);
    try {
      await page.evaluate(() => (window as any).__dwhE2eWaitPreviewStarted());
    } finally {
      await page.evaluate(() => (window as any).__dwhE2eReleasePreviewHold());
    }
    await page.evaluate(() => (window as any).__dwhE2eWaitPreviewSettled());
    await expect(recompute).toBeEnabled();
    await expect(page.getByText(/No such file|os error 2/i).first()).toBeVisible();
    expect(await currentProject(page)).toEqual(before);
  });

  test("Mapping drafts survive Cancel and are not silently treated as project Save", async () => {
    const { page } = session;
    await openReconLab(page);
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    const lab = await currentProject(page);
    const map = lab.workspace.key_maps!.find((m) => m.id === "map_sku")!;
    await page.getByTestId(`pg-keymap-${map.name}`).click();
    const cell = page.locator('input[data-col="to"]').first();
    await cell.fill("unsaved_mapping_value");
    await openReconLab(page);
    await expect(switchDialog(page).getByText(/Mapping or Matching has unsaved drafts/)).toBeVisible();
    await switchDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId(`pg-keymap-${map.name}`).click();
    await expect(cell).toHaveValue("unsaved_mapping_value");
    await openReconLab(page);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Save Mapping and Matching drafts in their editors first/)).toBeVisible();
    expect((await currentProject(page)).project_uid).toBe(lab.project_uid);
    await page.getByTestId(`pg-keymap-${map.name}`).click();
    await expect(cell).toHaveValue("unsaved_mapping_value");
  });

  test("Open Recent protects unsaved work with the same Cancel dialog", async () => {
    const { page, projectPath } = session;
    await editProject(page);
    const before = await currentProject(page);
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("button", { name: /Open Recent/ }).hover();
    await page.locator("button[title]").filter({ hasText: projectPath }).click();
    await expect(switchDialog(page)).toBeVisible();
    await switchDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await currentProject(page)).toEqual(before);
  });

  test("failed Open Recent still prunes the unavailable recent entry", async () => {
    const { page, projectPath } = session;
    fs.unlinkSync(projectPath);
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("button", { name: /Open Recent/ }).hover();
    await page.locator("button[title]").filter({ hasText: projectPath }).click();
    await expect(page.getByText(/No such file|os error 2/i).first()).toBeVisible();
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("button", { name: /Open Recent/ }).hover();
    await expect(page.getByText("No recent projects", { exact: true })).toBeVisible();
  });

  test("load failure after successful Save keeps the saved working project open", async () => {
    const { page, app, projectPath, fixtureWorkDir } = session;
    await editProject(page);
    const uid = (await currentProject(page)).project_uid;
    await openPicker(app, path.join(fixtureWorkDir, "missing.dwhproj.json"));
    await fileMenu(page, /^Open…/);
    await switchDialog(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/No such file|os error 2/i).first()).toBeVisible();
    expect(JSON.parse(fs.readFileSync(projectPath, "utf8")).workspace.queries[0].name).toBe("unsaved_work");
    expect((await currentProject(page)).project_uid).toBe(uid);
    expect((await currentProject(page)).root_path).toBe(projectPath);
    await openReconLab(page);
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    await expect(switchDialog(page)).toBeHidden();
  });

  test("Save as preserves the old file and establishes a clean fork baseline", async () => {
    const { page, app, projectPath, fixtureWorkDir } = session;
    const bytes = fs.readFileSync(projectPath, "utf8");
    const uid = (await currentProject(page)).project_uid;
    await editProject(page);
    const forkPath = path.join(fixtureWorkDir, "fork.dwhproj.json");
    await savePicker(app, forkPath);
    await fileMenu(page, /^Save as…$/);
    await expect.poll(async () => (await currentProject(page)).root_path).toBe(forkPath);
    const fork = JSON.parse(fs.readFileSync(forkPath, "utf8"));
    expect(fork.project_uid).not.toBe(uid);
    expect(fork.workspace.queries[0].name).toBe("unsaved_work");
    expect(fs.readFileSync(projectPath, "utf8")).toBe(bytes);
    await openReconLab(page);
    await expect.poll(async () => (await currentProject(page)).name).toBe("demo_recon_ship_sales");
    await expect(switchDialog(page)).toBeHidden();
  });
});
