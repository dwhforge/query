import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";

// No mocked bridge: UI retrieval/Mapping/Apply and Save/Open all use the sidecar.
async function joinedRows(page: Page) {
  return page.evaluate(async () => {
    const w = window as any;
    const p = w.__dwhE2eGetProject();
    const reply = await w.dwh.invoke("preview_workspace", {
      workspace: p.workspace, connections: p.connections, sources: p.sources,
      projectFile: p.root_path, rowLimit: 50,
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  });
}

function partners(result: any) {
  const id = result.columns.findIndex((c: any) => c.name === "row_id");
  const partner = result.columns.findIndex((c: any) => c.name === "partner");
  return Object.fromEntries(result.rows.map((r: any[]) => [r[id], r[partner]]));
}

for (const width of [1, 2, 3, 4, 5]) {
  test(`Unified Suggest Right ${width}-key UI Mapping Apply Save/Reopen isolates full context`, async ({}, info) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-tuple-ui-"));
    let session: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      const leftOn = ["company", "country", "channel", "status", "revision"].slice(0, width);
      const rightOn = ["legal_name", "nation", "route", "state", "version"].slice(0, width);
      const source = width === 1 ? ["ABC UK"] : ["ABC", "UK", "retail", "old", "v1"].slice(0, width);
      const target = width === 1 ? ["ABC Limited UK"] : ["ABC Limited", "GB", "store", "active", "v2"].slice(0, width);
      const us = width === 1 ? ["ABC US"] : ["ABC", "US", "retail", "old", "v1"].slice(0, width);
      const third = width >= 3 ? ["ABC", "UK", "wholesale", "old", "v1"].slice(0, width) : ["XYZ", "UK"].slice(0, width);
      const left = path.join(dir, "left.csv");
      const right = path.join(dir, "right.csv");
      fs.writeFileSync(left, `row_id,${leftOn.join(",")}\nrow0,${source.join(",")}\nrow1,${us.join(",")}\nrow2,${third.join(",")}\n`);
      fs.writeFileSync(right, `partner,${[...rightOn].reverse().join(",")}\nuk,${[...target].reverse().join(",")}\n`);
      const project = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
      project.workspace = { focus_query_id: "fact", key_maps: [], queries: [
        { id: "fact", name: "fact", execution: "local", steps: [
          { type: "LoadCsv", payload: { path: left } },
          { type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: leftOn, right_on: rightOn } },
        ] },
        { id: "dim", name: "dim", execution: "local", steps: [{ type: "LoadCsv", payload: { path: right } }] },
      ] };
      const input = path.join(dir, "input.dwhproj.json");
      const savedPath = path.join(dir, "saved.dwhproj.json");
      fs.writeFileSync(input, JSON.stringify(project));
      session = await launchApp();
      let { page } = session;
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.evaluate((p) => (window as any).__dwhE2eOpenProject(p), input);
      await expect(page.getByRole("heading", { name: "fact", exact: true })).toBeVisible();
      await expect(page.getByTestId("preview-state")).toHaveCount(0);
      expect(partners(await joinedRows(page))).toEqual({ row0: null, row1: null, row2: null });
      await page.locator('[data-step-type="Join"] > [role="button"]').click();
      const lens = page.getByRole("button", { name: "Join Lens", exact: true });
      if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
      const gotIt = page.getByRole("button", { name: "Got it", exact: true });
      if (await gotIt.isVisible()) await gotIt.click();
      await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
      await page.getByTestId("join-lens-no-match").click();
      await page.getByRole("row").filter({ hasText: "row0" }).first().click();
      // Real Host candidate inspection is read-only and does not replace Suggest Right.
      const beforeCandidates = await page.evaluate(() => JSON.stringify((window as any).__dwhE2eGetProject().workspace));
      const rightPane = page.getByTestId("join-lens-right-pane");
      await rightPane.getByRole("button", { name: "Candidates", exact: true }).click();
      const candidates = page.getByTestId("join-lens-candidates");
      await expect(candidates.getByTestId("right-candidate").first()).toBeVisible();
      await expect(candidates.getByTestId("candidate-source")).toContainText("UK");
      for (const name of rightOn) await expect(candidates.getByTestId("right-candidate").first()).toContainText(name);
      await candidates.getByTestId("right-candidate").first().locator("summary").click();
      for (let i = 0; i < width; i++) await expect(candidates.getByTestId("right-candidate").first()).toContainText(`${leftOn[i]} → ${rightOn[i]}`);
      await expect(candidates).toContainText("Mean score:");
      expect(await page.evaluate(() => JSON.stringify((window as any).__dwhE2eGetProject().workspace))).toBe(beforeCandidates);
      await rightPane.getByRole("button", { name: "No match", exact: true }).click();
      await expect(candidates).toHaveCount(0);
      await rightPane.getByRole("button", { name: "Candidates", exact: true }).click();
      await expect(candidates.getByTestId("right-candidate").first()).toBeVisible();
      await page.getByTestId("join-lens-right-pane").getByRole("button", { name: "Suggest…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Suggest Right", exact: true });
      await expect(dialog.getByRole("region", { name: "Source tuple" })).toContainText("UK");
      await dialog.getByText("Search other records").click();
      const manual = dialog.getByRole("region", { name: "Manual right search" });
      await expect(manual).toContainText("ABC Limited");
      await manual.getByRole("radio").first().check();
      await dialog.getByRole("button", { name: "Add to mapping", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.getByRole("button", { name: "Apply to left", exact: true }).click();
      if (width > 1) {
        for (let i = 0; i < width; i++) {
          await expect(page.getByRole("textbox", { name: `Destination for to_${i + 1}_${rightOn[i]}`, exact: true })).toHaveValue(leftOn[i]);
        }
        await page.getByRole("button", { name: "Apply map only", exact: true }).click();
      }
      await expect.poll(async () => partners(await joinedRows(page))).toEqual({ row0: "uk", row1: null, row2: null });
      await page.evaluate(async (p) => (window as any).__dwhE2eSaveProject(p), savedPath);
      await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
      const map = saved.workspace.key_maps[0];
      expect(map.from_columns).toEqual(leftOn.map((c, i) => `from_${i + 1}_${c}`));
      expect(map.output_columns).toEqual(rightOn.map((c, i) => `to_${i + 1}_${c}`));
      expect(map.entries[0].from_parts).toEqual(source);
      expect(map.entries[0].output_values).toEqual(target);
      expect(saved.workspace.queries[0].steps.map((s: any) => s.type)).toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
      // Fresh Electron + fresh sidecar: neither React state nor DuckDB caches
      // can masquerade as a successful disk round-trip.
      await closeIsolatedSession(session);
      session = undefined;
      session = await launchApp();
      page = session.page;
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.evaluate((p) => (window as any).__dwhE2eOpenProject(p), savedPath);
      await expect.poll(() => page.evaluate(() => (window as any).__dwhE2eGetProject().root_path)).toBe(savedPath);
      expect(partners(await joinedRows(page))).toEqual({ row0: "uk", row1: null, row2: null });
      await page.screenshot({ path: info.outputPath(`tuple-${width}-saved-reopened.png`) });
    } finally {
      await closeIsolatedSession(session);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
