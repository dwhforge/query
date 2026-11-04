/**
 * Launch DWHForge Electron against a built `dist/` + release `dwh-host`,
 * with isolated HOME / user-data (ADR-0021 settings away from the developer).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

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
  return home;
}

export function ensureHostAndUiBuilt() {
  const hostName = process.platform === "win32" ? "dwh-host.exe" : "dwh-host";
  const hostBin = path.join(root, "target/release", hostName);
  if (!fs.existsSync(hostBin)) {
    const r = spawnSync("cargo", ["build", "-p", "dwh-host", "--release"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) throw new Error("host:build failed");
  }
  const indexHtml = path.join(root, "dist/index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      "dist/index.html missing — run `npm run test:e2e:electron` (builds UI) or `npm run build`",
    );
  }
}

/**
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page, home: string, userData: string }>}
 */
export async function launchApp() {
  ensureHostAndUiBuilt();
  const home = prepareIsolatedHome();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-e2e-ud-"));
  const electronBin = path.join(root, "node_modules", ".bin", "electron");
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
  return { app, page, home, userData };
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

export async function openCreateWizard(page) {
  await page.getByTestId("create-mapping-from-data").click();
  await page.getByTestId("mapping-create-wizard").waitFor({ state: "visible" });
}

export function wizard(page) {
  return page.getByTestId("mapping-create-wizard");
}
