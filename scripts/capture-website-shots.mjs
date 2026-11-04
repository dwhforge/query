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

/**
 * Thumb = tight crop of `locator`.
 * Full = wider context (must differ from thumb — never duplicate the same clip).
 *   fullMode: "viewport" | "pad" (pad expands the crop)
 */
async function shot(
  page,
  locator,
  name,
  { pad = 8, fullMode = "viewport", fullPad = 48 } = {},
) {
  await locator.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(500);
  const box = await locator.boundingBox();
  if (!box || box.width < 80 || box.height < 80) {
    throw new Error(`shot ${name}: box too small ${JSON.stringify(box)}`);
  }
  const thumbClip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2),
    height: Math.ceil(box.height + pad * 2),
  };
  const thumbPath = path.join(outDir, `${name}.png`);
  const fullPath = path.join(outDir, `${name}-full.png`);
  await page.screenshot({ path: thumbPath, clip: thumbClip, type: "png" });

  if (fullMode === "viewport") {
    await page.screenshot({ path: fullPath, type: "png", fullPage: false });
  } else {
    const vp = page.viewportSize() || { width: 1440, height: 900 };
    const fullClip = {
      x: Math.max(0, Math.floor(box.x - fullPad)),
      y: Math.max(0, Math.floor(box.y - fullPad)),
      width: Math.min(
        vp.width - Math.max(0, Math.floor(box.x - fullPad)),
        Math.ceil(box.width + fullPad * 2),
      ),
      height: Math.min(
        vp.height - Math.max(0, Math.floor(box.y - fullPad)),
        Math.ceil(box.height + fullPad * 2),
      ),
    };
    await page.screenshot({ path: fullPath, clip: fullClip, type: "png" });
  }
  // Guard: never publish a -full that is a byte copy of the thumb.
  const thumbBytes = fs.readFileSync(thumbPath);
  const fullBytes = fs.readFileSync(fullPath);
  if (thumbBytes.equals(fullBytes)) {
    fs.unlinkSync(fullPath);
    throw new Error(
      `shot ${name}: -full identical to thumb (${thumbClip.width}×${thumbClip.height}) — tighten the thumb locator or capture full after a different layout`,
    );
  }
  console.log(
    `wrote ${name}.png (${thumbClip.width}×${thumbClip.height}) + ${name}-full.png`,
  );
}

/** Drive Help → Mapping labs / demos via real menu (no App.tsx capture hooks). */
async function loadDemoFromMenu(page, menuLabel) {
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("button", { name: menuLabel }).click();
}

async function focusJoinLensFromMenu(page) {
  // exact: avoid React Flow "Fit View" control.
  await page.getByRole("button", { name: "View", exact: true }).click();
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
  // Thumb = wizard dialog; full = whole window for lightbox context.
  await shot(page, dlg, "create-mapping", { pad: 12, fullMode: "viewport" });
}

async function captureJoinLens(page) {
  await loadDemoFromMenu(page, "F&B hub — seed · daily → month");
  await page.getByText("dirty_join", { exact: true }).first().waitFor({
    timeout: 60_000,
  });
  await page.getByText("dirty_join", { exact: true }).first().click();
  await page.waitForTimeout(400);
  await dismissOverlays(page);
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

  // JoinLens root chrome (not the header strip, not viewport ancestors).
  const lensRoot = page
    .locator(
      "div.relative.flex.min-h-0.min-w-0.flex-1.flex-col.overflow-hidden.rounded-lg.border",
    )
    .filter({ has: page.getByText("Join Lens", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "No match" }) })
    .first();

  // Thumb = dock panel in normal layout (canvas still above).
  // Full = after Focus Join Lens (sides collapsed, dock maximized).
  const thumbPath = path.join(outDir, "join-lens.png");
  const fullPath = path.join(outDir, "join-lens-full.png");
  await lensRoot.waitFor({ state: "visible", timeout: 90_000 });
  const box = await lensRoot.boundingBox();
  if (!box || box.width < 200 || box.height < 160) {
    throw new Error(`join-lens thumb box too small ${JSON.stringify(box)}`);
  }
  const pad = 6;
  const thumbClip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.ceil(box.width + pad * 2),
    height: Math.ceil(box.height + pad * 2),
  };
  await page.screenshot({ path: thumbPath, clip: thumbClip, type: "png" });

  await focusJoinLensFromMenu(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: fullPath, type: "png", fullPage: false });

  const thumbBytes = fs.readFileSync(thumbPath);
  const fullBytes = fs.readFileSync(fullPath);
  if (thumbBytes.equals(fullBytes)) {
    fs.unlinkSync(fullPath);
    throw new Error(
      "join-lens: -full identical to thumb — dock was already fullscreen",
    );
  }
  console.log(
    `wrote join-lens.png (${thumbClip.width}×${thumbClip.height}) + join-lens-full.png`,
  );
}

async function dumpMappingQualityDebug(page, label) {
  const debug = path.join(outDir, `_debug-mapping-quality.png`);
  try {
    await page.screenshot({ path: debug, type: "png", fullPage: false });
  } catch (err) {
    console.error(`debug screenshot failed (${label}):`, err?.message || err);
  }
  const body = await page
    .locator("section.quality-overview")
    .innerText()
    .catch(() => page.locator("body").innerText().catch(() => ""));
  const mint = await page
    .locator(".quality-mint")
    .first()
    .textContent()
    .catch(() => null);
  console.error(
    `mapping-quality debug (${label}): mint=${JSON.stringify(mint)}\n---\n${String(body).slice(0, 1200)}\n---\n→ ${debug}`,
  );
}

async function captureMappingQuality(page) {
  await loadDemoFromMenu(
    page,
    "Mapping quality — 100K products · overview prototype",
  );
  await page.getByRole("tab", { name: /Mapping quality/i }).waitFor({
    timeout: 90_000,
  });
  await dismissOverlays(page);

  const overview = page.locator("section.quality-overview").first();
  await overview.waitFor({ state: "visible", timeout: 60_000 });

  // Error UI reuses `.quality-loading` — do not wait for "hidden" alone.
  const ready = page.locator(".quality-mint");
  const failed = overview.locator('[role="alert"]');
  const deadline = Date.now() + 300_000;
  let sawZeroSince = null;
  while (Date.now() < deadline) {
    if (await failed.isVisible().catch(() => false)) {
      await dumpMappingQualityDebug(page, "analysis-unavailable");
      throw new Error("mapping-quality: analysis unavailable (see debug dump)");
    }
    if (await ready.isVisible().catch(() => false)) {
      const t = ((await ready.textContent()) || "").trim();
      const m = t.match(/^(\d+(?:\.\d+)?)%$/);
      if (m && Number(m[1]) > 0) break;
      if (m && Number(m[1]) === 0) {
        sawZeroSince ??= Date.now();
        // Stable 0% after load = map not applied (lab bug), not "still settling".
        if (Date.now() - sawZeroSince > 15_000) {
          await dumpMappingQualityDebug(page, "coverage-0");
          throw new Error("mapping-quality: Catalog coverage stuck at 0%");
        }
      } else {
        sawZeroSince = null;
      }
    }
    await page.waitForTimeout(1_000);
  }
  if (!(await ready.isVisible().catch(() => false))) {
    await dumpMappingQualityDebug(page, "timeout-no-mint");
    throw new Error("mapping-quality: timed out waiting for Catalog coverage");
  }
  const mintText = ((await ready.textContent()) || "").trim();
  const mintMatch = mintText.match(/^(\d+(?:\.\d+)?)%$/);
  if (!mintMatch || Number(mintMatch[1]) <= 0) {
    await dumpMappingQualityDebug(page, `coverage-${mintText}`);
    throw new Error(`mapping-quality: coverage still ${mintText}`);
  }

  await page.getByText("Where do the products go?", { exact: false }).waitFor({
    timeout: 30_000,
  });

  await shot(page, overview, "mapping-quality", {
    pad: 8,
    fullMode: "viewport",
  });
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
