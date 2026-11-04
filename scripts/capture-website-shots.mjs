#!/usr/bin/env node
/**
 * Shot runners for `website/capture.config.mjs`.
 * Prefer: `npm run capture:website` (builds capture UI + host).
 *
 *   node scripts/capture-website-shots.mjs [--only create-mapping]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeIsolatedSession,
  launchApp,
  openCreateWizard,
  openFixtureProject,
  wizard,
} from "../e2e/electron/helpers/launch.mjs";
import captureConfig from "../website/capture.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, captureConfig.outDir);

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? onlyArg.slice("--only=".length)
  : process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : null;

async function shot(page, locator, name, { pad = 8 } = {}) {
  await locator.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(500);
  const box = await locator.boundingBox();
  if (!box || box.width < 80 || box.height < 80) {
    throw new Error(`shot ${name}: box too small ${JSON.stringify(box)}`);
  }
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2),
    height: Math.ceil(box.height + pad * 2),
  };
  await page.screenshot({
    path: path.join(outDir, `${name}-full.png`),
    clip,
    type: "png",
  });
  await page.screenshot({
    path: path.join(outDir, `${name}.png`),
    clip,
    type: "png",
  });
  console.log(`wrote ${name}.png (${clip.width}×${clip.height})`);
}

/** Drive Help → Mapping labs / demos via real menu (no App.tsx capture hooks). */
async function loadDemoFromMenu(page, menuLabel) {
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("button", { name: menuLabel }).click();
}

async function focusJoinLensFromMenu(page) {
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Focus Join Lens" }).click();
}

async function dismissOverlays(page) {
  for (let i = 0; i < 6; i++) {
    const discard = page.getByTestId("mapping-create-discard");
    if (await discard.isVisible().catch(() => false)) {
      await discard.getByRole("button", { name: "Discard" }).click();
      await page.waitForTimeout(200);
      continue;
    }
    const gotIt = page.getByRole("button", { name: "Got it" });
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click();
      await page.waitForTimeout(200);
      continue;
    }
    const overlay = page.locator("div.fixed.inset-0.z-50");
    if (await overlay.first().isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      continue;
    }
    break;
  }
}

async function withSession(fn) {
  process.env.DWH_E2E_SKIP_HOST_BUILD =
    process.env.DWH_E2E_SKIP_HOST_BUILD || "1";
  const { app, page, home, userData } = await launchApp();
  const { width, height } = captureConfig.window;
  try {
    await page.setViewportSize({ width, height }).catch(() => {});
    try {
      await app.evaluate(
        async ({ BrowserWindow }, size) => {
          const w = BrowserWindow.getAllWindows()[0];
          if (w) {
            w.setSize(size.width, size.height);
            w.center();
          }
        },
        { width, height },
      );
    } catch {
      /* ignore */
    }
    await fn(page);
  } finally {
    await closeIsolatedSession({ app, home, userData, fixtureWorkDir: null });
  }
}

async function captureCreateMapping(page) {
  await openFixtureProject(page);
  await openCreateWizard(page);
  const dlg = wizard(page);
  await dlg
    .getByPlaceholder("Supplier products → catalog")
    .fill("Supplier → catalog");
  await dlg.locator("select").nth(0).selectOption("supplier_products");
  await dlg.locator("select").nth(1).selectOption("catalog_products");
  await dlg.getByRole("button", { name: "Next" }).click();
  await dlg.getByText("Source — excluded by last Fields", { exact: true }).waitFor({
    timeout: 60_000,
  });
  // Ready: restores lists visible, not "Loading schema…".
  await dlg.getByRole("button", { name: "Next" }).waitFor({ state: "visible" });
  await shot(page, dlg, "create-mapping", { pad: 12 });
}

async function captureJoinLens(page) {
  await loadDemoFromMenu(page, "F&B hub — seed · daily → month");
  await page.getByText("dirty_join", { exact: true }).first().waitFor({
    timeout: 60_000,
  });
  await page.getByText("dirty_join", { exact: true }).first().click();
  await page.waitForTimeout(400);
  await dismissOverlays(page);
  await focusJoinLensFromMenu(page);
  await page.getByText("Join Lens", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await dismissOverlays(page);

  const thisRow = page.getByRole("button", { name: "This row" });
  const noMatch = page.getByRole("button", { name: "No match" });
  await thisRow.waitFor({ state: "visible", timeout: 30_000 });
  await noMatch.click();
  // Ready: No match mode active + Suggest all is a button (not a tab).
  await page.getByRole("button", { name: /Suggest all/i }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.waitForTimeout(800);

  // Prefer the Join Lens chrome root (title → nearest large panel).
  const lensRoot = page
    .locator("div")
    .filter({ has: page.getByText("Join Lens", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "No match" }) })
    .first();
  await shot(page, lensRoot, "join-lens", { pad: 6 });
}

async function captureMappingQuality(page) {
  await loadDemoFromMenu(
    page,
    "Mapping quality — 100K products · overview prototype",
  );
  await page.getByRole("tab", { name: /Mapping quality/i }).waitFor({
    timeout: 60_000,
  });

  // Explicitly wait OUT of the loading / waiting UI — never screenshot it.
  const loading = page.locator(".quality-loading");
  await page.getByText("Reading the whole mapping").waitFor({
    state: "visible",
    timeout: 30_000,
  }).catch(() => {});
  await loading.waitFor({ state: "hidden", timeout: 300_000 });

  // Ready product state: non-zero coverage (seed applied) and matrix present.
  await page.getByText("Catalog coverage", { exact: true }).waitFor({
    timeout: 30_000,
  });
  // Coverage must be meaningfully non-zero (seed applied). Locale may use
  // "95.0%" or "95%"; reject bare 0 / 0.0%.
  try {
    await page.waitForFunction(
      () => {
        const mint = document.querySelector(".quality-mint");
        if (!mint) return false;
        const t = (mint.textContent || "").trim();
        const m = t.match(/^(\d+(?:\.\d+)?)%$/);
        if (!m) return false;
        return Number(m[1]) > 0;
      },
      null,
      { timeout: 180_000 },
    );
  } catch (e) {
    const debug = path.join(outDir, "_debug-mapping-quality.png");
    await page.screenshot({ path: debug, type: "png", fullPage: true });
    const mint = await page.locator(".quality-mint").first().textContent().catch(() => null);
    const loadingVisible = await page.locator(".quality-loading").isVisible().catch(() => false);
    console.error(
      `mapping-quality not ready (mint=${JSON.stringify(mint)} loading=${loadingVisible}) → ${debug}`,
    );
    throw e;
  }
  await page.getByText("Where do the products go?", { exact: false }).waitFor({
    timeout: 30_000,
  });

  const panel = page.locator("section.quality-overview").first();
  await shot(page, panel, "mapping-quality", { pad: 8 });
}

async function main() {
  const handlers = {
    "create-mapping": captureCreateMapping,
    "join-lens": captureJoinLens,
    "mapping-quality": captureMappingQuality,
  };
  fs.mkdirSync(outDir, { recursive: true });
  for (const shotDef of captureConfig.shots) {
    if (only && only !== shotDef.id) continue;
    if (!only && !shotDef.enabled) {
      console.log(`→ ${shotDef.id} skipped (${shotDef.note || "disabled"})`);
      continue;
    }
    if (only && !shotDef.enabled) {
      console.warn(
        `→ ${shotDef.id}: forcing disabled shot via --only (${shotDef.note || "see capture.config.mjs"})`,
      );
    }
    const fn = handlers[shotDef.id];
    if (!fn) throw new Error(`no handler for shot ${shotDef.id}`);
    console.log(`→ ${shotDef.id} (fresh app) — ready: ${shotDef.ready}`);
    await withSession(fn);
  }
  console.log("done →", outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
