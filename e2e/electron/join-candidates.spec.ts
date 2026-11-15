import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";

test("Candidates use the full real right input even with zero unmatched right rows; modal is independent", async ({}, info) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-candidates-"));
  let session: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    const left = path.join(dir, "left.csv");
    const right = path.join(dir, "right.csv");
    fs.writeFileSync(left, "row_id,company,country\nmiss,Acme Ltd,UK\njoined,Acme Limited,GB\n");
    // Physical file order is deliberately not Join-pair order.
    fs.writeFileSync(right, "nation,partner,legal_name\nGB,real partner,Acme Limited\n");
    const project = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
    project.workspace = { focus_query_id: "fact", key_maps: [], queries: [
      {id: "fact", name: "fact", execution: "local", steps: [
        {type: "LoadCsv", payload: {path: left}},
        {type: "Join", payload: {right_query_id: "dim", join_type: "left", left_on: ["company", "country"], right_on: ["legal_name", "nation"]}},
      ]},
      {id: "dim", name: "dim", execution: "local", steps: [{type: "LoadCsv", payload: {path: right}}]},
    ]};
    const input = path.join(dir, "input.dwhproj.json");
    fs.writeFileSync(input, JSON.stringify(project));
    session = await launchApp();
    const {page} = session;
    await page.setViewportSize({width: 1700, height: 1200});
    await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
    await expect(page.getByRole("heading", {name: "fact", exact: true})).toBeVisible();
    await expect(page.getByTestId("preview-state")).toHaveCount(0);
    await page.locator('[data-step-type="Join"] > [role="button"]').click();
    const lens = page.getByRole("button", {name: "Join Lens", exact: true});
    if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
    const gotIt = page.getByRole("button", {name: "Got it", exact: true});
    if (await gotIt.isVisible()) await gotIt.click();
    await page.getByRole("separator", {name: "Resize data panel", exact: true}).dblclick();
    await page.getByTestId("join-lens-no-match").click();
    await page.getByRole("row").filter({hasText: "miss"}).first().click();
    const rightPane = page.getByTestId("join-lens-right-pane");
    // Real diagnostics, not a mocked empty list.
    await expect(rightPane).toContainText("right, no match · 0/0 of 0");
    const before = await page.evaluate(() => JSON.stringify((window as any).__dwhE2eGetProject().workspace));
    await rightPane.getByRole("button", {name: "Candidates", exact: true}).click();
    const candidates = page.getByTestId("join-lens-candidates");
    await expect(candidates.getByTestId("right-candidate")).toHaveCount(1);
    await expect(candidates.getByTestId("candidate-source")).toContainText('"Acme Ltd"');
    await expect(candidates).toContainText('"Acme Limited"');
    await expect(candidates).toContainText('"GB"');
    await expect(candidates.getByTestId("candidate-coverage")).toContainText("1 / 1 distinct tuples");
    await candidates.locator("summary").click();
    await expect(candidates).toContainText("company → legal_name");
    await expect(candidates).toContainText("country → nation");
    await expect(candidates.getByRole("radio")).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify((window as any).__dwhE2eGetProject().workspace))).toBe(before);
    await rightPane.getByRole("button", {name: "Suggest…", exact: true}).click();
    const modal = page.getByRole("dialog", {name: "Suggest Right", exact: true});
    await expect(modal.getByRole("region", {name: "Source tuple"})).toContainText('"Acme Ltd"');
    await expect(modal.getByRole("button", {name: "Add to mapping", exact: true})).toBeDisabled();
    await modal.getByRole("button", {name: "Close", exact: true}).click();
    await expect(candidates.getByTestId("right-candidate")).toHaveCount(1);
    expect(await page.evaluate(() => JSON.stringify((window as any).__dwhE2eGetProject().workspace))).toBe(before);
    await page.screenshot({path: info.outputPath("real-right-candidates.png")});
  } finally {
    await closeIsolatedSession(session);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
