/**
 * Launch DWHForge Electron against a built `dist/` + release `dwh-host`,
 * with isolated HOME / user-data (ADR-0021 settings away from the developer).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, _electron as electron } from "@playwright/test";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function fixtureTemplateDir() {
  return path.join(root, "e2e/electron/fixtures/mapping-create");
}

/**
 * Copy fixture into a temp dir with absolute LoadCsv paths (host resolves
 * relative paths against process cwd, not the project file).
 */
export function materializeFixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-e2e-proj-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of ["supplier.csv", "catalog.csv"]) {
    fs.copyFileSync(
      path.join(fixtureTemplateDir(), "data", name),
      path.join(dataDir, name),
    );
  }
  const template = JSON.parse(
    fs.readFileSync(
      path.join(fixtureTemplateDir(), "smoke.dwhproj.json"),
      "utf8",
    ),
  );
  const abs = (rel) => path.join(dir, rel);
  for (const q of template.workspace.queries) {
    for (const s of q.steps) {
      if (s.type === "LoadCsv" && s.payload?.path) {
        s.payload.path = abs(s.payload.path);
      }
    }
  }
  const projectPath = path.join(dir, "smoke.dwhproj.json");
  fs.writeFileSync(projectPath, JSON.stringify(template, null, 2));
  return { dir, projectPath };
}

/** @deprecated use materializeFixtureProject().projectPath */
export function fixtureProjectPath() {
  return path.join(fixtureTemplateDir(), "smoke.dwhproj.json");
}

export function fixtureDir() {
  return fixtureTemplateDir();
}

/** Write a minimal ~/.dwhforge-query that skips first-run dbt dialog. */
export function prepareIsolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-e2e-home-"));
  const dwh = path.join(home, ".dwhforge-query");
  fs.mkdirSync(dwh, { recursive: true });
  fs.writeFileSync(
    path.join(dwh, "settings.json"),
    JSON.stringify(
      {
        default_target_dialect: "duckdb",
        default_dbt_target: "v1",
        default_execution_engine: "duckdb",
        default_destination_kind: "duckdb",
        dbt_venv_path: "",
        dbt_setup_dismissed: true,
        recent_projects: [],
        explorer_width_px: 240,
        inspector_width_px: 300,
      },
      null,
      2,
    ),
  );
  // Join Lens first-use modal (localStorage key is per origin; Electron file://
  // may still show it — capture script also clicks "Got it").
  return home;
}

/**
 * Resolve the host binary Electron main would pick (portable beside app wins).
 * @returns {{ path: string, via: string }}
 */
export function resolveHostBinary() {
  const name = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
  const portable = path.join(root, name);
  if (fs.existsSync(portable)) {
    return { path: portable, via: "portable-beside-app" };
  }
  const release = path.join(root, "target/release", name);
  if (fs.existsSync(release)) {
    return { path: release, via: "target/release" };
  }
  const debug = path.join(root, "target/debug", name);
  return { path: debug, via: "target/debug" };
}

/**
 * Ensure host + UI exist for Playwright workers.
 * Freshness: `scripts/run-electron-e2e.mjs` always `cargo build`s before tests.
 * Here we rebuild only when the binary is missing, unless
 * `DWH_E2E_FORCE_HOST_BUILD=1` (or skip via `DWH_E2E_SKIP_HOST_BUILD=1`).
 */
export function ensureHostAndUiBuilt() {
  const hostName = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
  const releaseBin = path.join(root, "target/release", hostName);
  const skipHost = process.env.DWH_E2E_SKIP_HOST_BUILD === "1";
  const forceHost = process.env.DWH_E2E_FORCE_HOST_BUILD === "1";
  if (skipHost) {
    console.log("skipping host build (DWH_E2E_SKIP_HOST_BUILD=1)");
  } else if (forceHost || !fs.existsSync(releaseBin)) {
    console.log("building dwh-host (release)…");
    const r = spawnSync("cargo", ["build", "-p", "dwh-host", "--release"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) throw new Error("host:build failed");
  }
  const resolved = resolveHostBinary();
  console.log(`e2e host binary: ${resolved.path} (${resolved.via})`);
  if (!fs.existsSync(resolved.path)) {
    throw new Error(`dwh-host missing at ${resolved.path}`);
  }
  if (resolved.via === "portable-beside-app") {
    console.warn(
      "WARNING: portable dwh-host beside the app takes precedence over target/release — rebuild that binary too if host sources changed.",
    );
  }
  const indexHtml = path.join(root, "dist/index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      "dist/index.html missing — run `npm run test:e2e:electron` (builds UI with DWH_E2E=1) or rebuild dist",
    );
  }
  return resolved;
}

function electronExecutable() {
  // Real Chromium binary. Do not use node_modules/.bin/electron (cli.js wrapper):
  // Playwright must own the process stderr to see DevTools / inspect lines.
  try {
    const dist = require("electron");
    if (typeof dist === "string" && fs.existsSync(dist)) return dist;
  } catch {
    /* fall through */
  }
  return path.join(root, "node_modules", "electron", "dist", "electron");
}

/**
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page, home: string, userData: string, host: { path: string, via: string } }>}
 */
export async function launchApp() {
  const host = ensureHostAndUiBuilt();
  const home = prepareIsolatedHome();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-e2e-ud-"));
  const electronBin = electronExecutable();
  const app = await electron.launch({
    executablePath: electronBin,
    args: [
      ".",
      `--user-data-dir=${userData}`,
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-gpu",
    ],
    cwd: root,
    env: (() => {
      const env = {
        ...process.env,
        HOME: home,
        ELECTRON_DISABLE_SANDBOX: "1",
        DWH_DEVTOOLS: "0",
      };
      // Prefer dist/index.html (no Vite) for deterministic smoke.
      delete env.VITE_DEV_SERVER_URL;
      // Agent / IDE shells often set this; Electron then behaves as Node and
      // rejects --remote-debugging-port (Playwright cannot attach).
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      return env;
    })(),
    timeout: 120_000,
  });
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForLoadState("domcontentloaded");
  // Menubar is always present once React mounts.
  await page.getByRole("button", { name: "File" }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  // E2E hooks must exist — proves dist was built with DWH_E2E=1.
  await page.waitForFunction(
    () => typeof window.__dwhE2eOpenProject === "function",
    null,
    { timeout: 60_000 },
  );
  return { app, page, home, userData, host };
}

/**
 * Open fixture via renderer test hook (bypasses native dialog + menubar races).
 * Still exercises real `load_project` host IPC + React applyLoadedProject.
 * @returns {{ projectPath: string, dir: string }}
 */
export async function openFixtureProject(page) {
  const { dir, projectPath } = materializeFixtureProject();
  await page.waitForFunction(
    () => typeof window.__dwhE2eOpenProject === "function",
    null,
    { timeout: 60_000 },
  );
  await page.evaluate((p) => {
    window.__dwhE2eOpenProject(p);
  }, projectPath);
  await page.getByText(/Opened /, { timeout: 60_000 }).waitFor({
    state: "visible",
  });
  await page
    .getByRole("heading", { name: "supplier_products", exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
  return { projectPath, dir };
}

/**
 * Fresh Electron + materialized project for one test (isolation).
 * @returns {Promise<{ app, page, home, userData, fixtureWorkDir, projectPath, host }>}
 */
export async function launchIsolatedSession() {
  const { app, page, home, userData, host } = await launchApp();
  const { dir: fixtureWorkDir, projectPath } = await openFixtureProject(page);
  return { app, page, home, userData, fixtureWorkDir, projectPath, host };
}

export async function closeIsolatedSession(session) {
  if (!session) return;
  await session.app?.close().catch(() => {});
  for (const p of [session.home, session.userData, session.fixtureWorkDir]) {
    try {
      if (p) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function openCreateWizard(page) {
  await page.getByTestId("create-mapping-from-data").click();
  await page.getByTestId("mapping-create-wizard").waitFor({ state: "visible" });
}

/** Close create wizard, accepting the in-app discard confirm when draft is filled. */
export async function closeCreateWizard(page) {
  const dlg = wizard(page);
  if (!(await dlg.isVisible().catch(() => false))) return;
  await dlg.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByTestId("mapping-create-discard");
  if (await discard.isVisible().catch(() => false)) {
    await discard.getByRole("button", { name: "Discard" }).click();
  }
  await dlg.waitFor({ state: "hidden", timeout: 15_000 });
}

export function wizard(page) {
  return page.getByTestId("mapping-create-wizard");
}

/** Click Include for an exact excluded column label; fail if missing. */
export async function includeExcludedColumn(dlg, name) {
  const rows = dlg.locator("li").filter({ hasText: name });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const mono = (await row.locator(".font-mono").innerText()).trim();
    if (mono === name) {
      const include = row.getByRole("button", { name: "Include" });
      await expect(include).toBeVisible({ timeout: 15_000 });
      await include.click();
      await expect(row.getByRole("button", { name: "Remove" })).toBeVisible({
        timeout: 15_000,
      });
      return;
    }
  }
  throw new Error(`Include control for excluded column "${name}" not found`);
}
