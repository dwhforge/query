import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";

const tupleLabel = (parts: string[]) => parts.map(part => JSON.stringify(part)).join("; ");

// Real Electron, CSV, sidecar retrieval/scoring, Apply, Save and cold execution.
// Only the external model is replaced, by an actual loopback HTTP provider.
async function projectState(page: Page) {
  return page.evaluate(() => (window as any).__dwhE2eGetProject());
}

async function execute(page: Page) {
  return page.evaluate(async () => {
    const w = window as any;
    const p = w.__dwhE2eGetProject();
    const reply = await w.dwh.invoke("preview_workspace", {
      workspace: p.workspace, connections: p.connections, sources: p.sources,
      projectFile: p.root_path, rowLimit: 50,
    });
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    const result = reply.result;
    const id = result.columns.findIndex((c: any) => c.name === "row_id");
    const partner = result.columns.findIndex((c: any) => c.name === "partner");
    if (id < 0 || partner < 0) throw new Error(JSON.stringify(result));
    return result.rows.map((r: any[]) => [r[id], r[partner]])
      .sort((a: any[], b: any[]) => a[0].localeCompare(b[0]));
  });
}

for (const width of [1, 2, 3, 4, 5]) {
  test(`Unified batch ${width}-key fuzzy + LLM queue, one write, execution and cold Save/Reopen`, async ({}, info) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-batch-ui-"));
    let session: Awaited<ReturnType<typeof launchApp>> | undefined;
    const requests: { url?: string; body: any }[] = [];
    const serverErrors: string[] = [];
    const leftOn = ["company", "country", "channel", "status", "revision"].slice(0, width);
    const rightOn = ["legal_name", "nation", "route", "state", "version"].slice(0, width);
    // Both fuzzy pairs differ in EVERY aligned output, not just one fuzzy slot.
    const sources = [
      ["Acme Corporaton", "United Kingdm", "Retail North", "Active old", "Revision 10"],
      ["Beacon Industris", "United Stats", "Wholesale East", "Enabled old", "Edition 20"],
      ["ZXQ legacy", "ZZ", "obsolete", "retired", "ancient"],
    ].map(parts => parts.slice(0, width));
    const targets = [
      ["Acme Corporation", "United Kingdom", "Retail North East", "Active new", "Revision 11"],
      ["Beacon Industries", "United States", "Wholesale Eastern", "Enabled new", "Edition 21"],
      ["Orion Holdings", "Canada", "Digital", "Current", "Release 90"],
    ].map(parts => parts.slice(0, width));
    const regionGuard = [...sources[0]];
    regionGuard[width === 1 ? 0 : 1] = width === 1 ? "Acme US" : "United States";
    const thirdGuard = [...sources[0]];
    thirdGuard[width >= 3 ? 2 : 0] = width >= 3 ? "Wholesale South" : "Acme elsewhere";
    const rows = [...sources, regionGuard, thirdGuard, sources[0]];
    const baseline = rows.map((_, i) => [`row${i}`, null]);
    const expected = [["row0", "partner0"], ["row1", "partner1"], ["row2", "partner2"],
      ["row3", null], ["row4", null], ["row5", "partner0"]];
    const server = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        requests.push({ url: req.url, body: JSON.parse(raw) });
        const content = "Local fixture evidence.\n```json\n" + JSON.stringify({ pairs: [
          { from_parts: sources[2], to_parts: targets[2], why: "Known fixture legacy migration; review all fields." },
          // A second pending source in the SAME payload remains a proposal only.
          { from_parts: regionGuard, to_parts: targets[2], why: "Second source for independent review; do not accept automatically." },
          // Invalid invented tuple must not enter the shared queue or persisted map.
          { from_parts: sources[2], to_parts: targets[2].map(() => "INVENTED"), why: "Must be rejected." },
        ] }) + "\n```";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      } catch (e) {
        serverErrors.push(String(e));
        res.writeHead(500); res.end("Fixture server failure");
      }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback port");
      const left = path.join(dir, "left.csv"), right = path.join(dir, "right.csv");
      fs.writeFileSync(left, `row_id,${leftOn.join(",")}\n` + rows.map((r, i) => `row${i},${r.join(",")}`).join("\n") + "\n");
      // Physical column order deliberately opposes Join ON order.
      fs.writeFileSync(right, `partner,${[...rightOn].reverse().join(",")}\n` + targets.map((r, i) => `partner${i},${[...r].reverse().join(",")}`).join("\n") + "\n");
      const project = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
      project.workspace = { focus_query_id: "fact", key_maps: [], queries: [
        { id: "fact", name: "fact", execution: "local", steps: [
          { type: "LoadCsv", payload: { path: left } },
          { type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: leftOn, right_on: rightOn } },
        ] },
        { id: "dim", name: "dim", execution: "local", steps: [{ type: "LoadCsv", payload: { path: right } }] },
      ] };
      const input = path.join(dir, "input.dwhproj.json"), savedPath = path.join(dir, "saved.dwhproj.json");
      fs.writeFileSync(input, JSON.stringify(project));
      session = await launchApp();
      let { page } = session;
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
      await expect(page.getByRole("heading", { name: "fact", exact: true })).toBeVisible();
      expect(await execute(page)).toEqual(baseline);
      const before = (await projectState(page)).workspace;
      await page.locator('[data-step-type="Join"] > [role="button"]').click();
      const lens = page.getByRole("button", { name: "Join Lens", exact: true });
      if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
      const gotIt = page.getByRole("button", { name: "Got it", exact: true });
      if (await gotIt.isVisible()) await gotIt.click();
      await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
      // Test-local spy delegates every call to the existing real IPC handler.
      // No renderer bridge, host response, or application harness is replaced.
      await session.app.evaluate(({ ipcMain }) => {
        const state = globalThis as any;
        state.__batchRetrievals = 0;
        state.__batchReports = [];
        const handler = (ipcMain as any)._invokeHandlers.get("dwh:invoke");
        if (!handler) throw new Error("Real dwh:invoke handler is missing");
        ipcMain.removeHandler("dwh:invoke");
        ipcMain.handle("dwh:invoke", async (event, command, ...args) => {
          if (command === "join_key_fuzzy_suggest") state.__batchRetrievals++;
          const reply = await handler(event, command, ...args);
          if (command === "join_key_fuzzy_suggest") state.__batchReports.push(reply.result?.tuple_report);
          return reply;
        });
      });
      const retrievalCount = () => session!.app.evaluate(() => (globalThis as any).__batchRetrievals as number);
      await page.getByRole("button", { name: "Find Matches", exact: true }).click();
      const batch = page.locator('[aria-label="Find Matches"]');
      const queue = batch.getByRole("navigation", { name: "Tuple review queue" });
      await expect(queue.getByRole("button")).toHaveCount(5);
      await expect(batch).toContainText("5/5 unmatched source tuples (6 rows)");
      expect(await retrievalCount()).toBe(1);
      await expect(batch.getByRole("button", { name: "Write Mapping (0)", exact: true })).toBeDisabled();
      // Never fabricate qualifying scores. Some real scorer/arity combinations
      // conservatively disable bulk review because the full ranking is unavailable.
      const bulk = batch.getByRole("button", { name: /^Accept high-confidence suggestions \(\d+\)$/ });
      const bulkCount = Number((await bulk.innerText()).match(/\((\d+)\)/)![1]);
      console.log(`${width}-key real host bulk eligibility: ${bulkCount}`);
      if (bulkCount > 0) {
        const report = await session.app.evaluate(() => (globalThis as any).__batchReports[0]);
        expect(report.right_truncated).toBe(false);
        const qualifying = report.sources.filter((source: any) => {
          const ranked = [...source.candidates].sort((a: any, b: any) => b.score - a.score);
          return ranked.length === report.right_universe.length && ranked[0]?.score >= 0.88 &&
            (!ranked[1] || ranked[0].score - ranked[1].score >= 0.03);
        });
        expect(qualifying).toHaveLength(bulkCount);
        await expect(bulk).toBeEnabled();
        await bulk.click();
        await expect(batch.getByRole("button", { name: `Write Mapping (${bulkCount})`, exact: true })).toBeEnabled();
        await expect(queue.getByRole("button").filter({ hasText: "accepted ·" })).toHaveCount(bulkCount);
        expect((await projectState(page)).workspace).toEqual(before);
        expect(await execute(page)).toEqual(baseline);
        await batch.getByRole("button", { name: `Undo bulk acceptance (${bulkCount})`, exact: true }).click();
        await expect(batch.getByRole("button", { name: "Write Mapping (0)", exact: true })).toBeDisabled();
        await expect(queue.getByRole("button").filter({ hasText: "pending ·" })).toHaveCount(5);
        await expect(batch.getByRole("button", { name: /^Undo bulk acceptance/ })).toHaveCount(0);
        for (const radio of await batch.getByRole("radio").all()) await expect(radio).not.toBeChecked();
        expect((await projectState(page)).workspace).toEqual(before);
      } else {
        await expect(bulk).toBeDisabled();
        info.annotations.push({ type: "bulk eligibility", description: `${width}-key real host results: no qualifying untouched full-ranking suggestions; no bulk acceptance manufactured.` });
      }
      for (const i of [0, 1]) {
        await queue.getByRole("button").filter({ hasText: tupleLabel(sources[i]) }).click();
        const alternatives = batch.getByRole("region", { name: "Proposed alternatives" });
        // A radio in this section exists only if real Rust's full-field mean
        // cleared the fuzzy cutoff; manual search is never used here.
        await alternatives.getByRole("radio", { name: new RegExp(tupleLabel(targets[i])) }).check();
        await expect(alternatives).toContainText("fuzzy");
        await batch.getByRole("button", { name: "Accept selected", exact: true }).click();
      }
      await queue.getByRole("button").filter({ hasText: tupleLabel(sources[2]) }).click();
      await expect(batch.getByRole("region", { name: "Proposed alternatives" }).getByRole("radio")).toHaveCount(0);
      await batch.getByRole("button", { name: "Open LLM chat", exact: true }).click();
      const chat = batch.getByRole("region", { name: "LLM batch chat" });
      await chat.getByLabel("base_url", { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
      await chat.getByLabel("model", { exact: true }).fill("local-batch-fixture");
      await chat.getByRole("button", { name: "Save", exact: true }).click();
      await batch.getByRole("button", { name: "Ask LLM to rank candidates", exact: true }).click();
      await expect(batch).toContainText("LLM: 2 alternatives added");
      expect(serverErrors).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/v1/chat/completions");
      expect(requests[0].body.model).toBe("local-batch-fixture");
      const prompt = requests[0].body.messages[0].content;
      expect(prompt).toContain(JSON.stringify(sources[2]));
      expect(prompt).toContain(JSON.stringify(targets[2]));
      expect(prompt).toContain(JSON.stringify(regionGuard));
      expect(prompt).not.toContain(JSON.stringify(sources[1])); // accepted decisions excluded
      await queue.getByRole("button").filter({ hasText: tupleLabel(regionGuard) }).click();
      const secondAlternatives = batch.getByRole("region", { name: "Proposed alternatives" });
      await expect(secondAlternatives).toContainText("Second source for independent review");
      for (const radio of await secondAlternatives.getByRole("radio").all()) await expect(radio).not.toBeChecked();
      await expect(batch.getByRole("button", { name: "Accept selected", exact: true })).toBeDisabled();
      await expect(queue.getByRole("button").filter({ hasText: tupleLabel(regionGuard) })).toContainText("pending");
      await queue.getByRole("button").filter({ hasText: tupleLabel(sources[2]) }).click();
      const llmAlternatives = batch.getByRole("region", { name: "Proposed alternatives" });
      await expect(llmAlternatives).toContainText("llm");
      await expect(llmAlternatives.getByRole("radio")).toHaveCount(1);
      await expect(llmAlternatives.getByRole("radio")).not.toBeChecked();
      await llmAlternatives.getByRole("radio").check();
      await batch.getByRole("button", { name: "Accept selected", exact: true }).click();
      await expect(batch.getByRole("button", { name: "Write Mapping (3)", exact: true })).toBeEnabled();
      // Review is not mutation; accepted fuzzy and LLM decisions share one queue.
      expect((await projectState(page)).workspace).toEqual(before);
      expect(await execute(page)).toEqual(baseline);
      await page.evaluate(() => {
        const w = window as any;
        w.__batchSnapshots = [];
        w.__batchTimer = setInterval(() => {
          const ws = w.__dwhE2eGetProject().workspace;
          w.__batchSnapshots.push([ws.key_maps.length, ws.key_maps[0]?.entries.length ?? 0,
            ws.queries[0].steps.filter((s: any) => s.type === "ApplyKeyMap").length]);
        }, 0);
      });
      // Exactly one user commit, no per-row Apply or separate Mapping editor hop.
      await batch.getByRole("button", { name: "Write Mapping (3)", exact: true }).click();
      await info.attach("post-commit-review", { contentType: "application/json", body: JSON.stringify({
        retrievals: await retrievalCount(),
        review: await batch.allTextContents(),
        stepTypes: (await projectState(page)).workspace.queries[0].steps.map((s: any) => s.type),
      }, null, 2) });
      const summary = batch.getByRole("status");
      await expect(summary).toHaveText("Applied 3 complete tuple mappings.");
      await expect(batch).toContainText("Previous review decisions have been cleared.");
      await expect(queue).toHaveCount(0);
      await expect(batch.getByRole("button", { name: /^Write Mapping/ })).toHaveCount(0);
      await expect.poll(() => execute(page)).toEqual(expected);
      // Execution observes the committed Mapping AND inserted Apply; the Join's
      // new index/context must not silently remount/retrieve the review session.
      expect((await projectState(page)).workspace.queries[0].steps.map((s: any) => s.type))
        .toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
      await expect(summary).toHaveText("Applied 3 complete tuple mappings.");
      expect(await retrievalCount()).toBe(1);
      const snapshots = await page.evaluate(() => {
        const w = window as any; clearInterval(w.__batchTimer); return w.__batchSnapshots;
      });
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) expect([[0, 0, 0], [1, 3, 1]]).toContainEqual(snapshot);
      // Give unsolicited effects/replies a bounded observation window. Only the
      // subsequent explicit refresh may retrieve the remaining unmatched queue.
      await page.waitForTimeout(500);
      await expect(summary).toHaveText("Applied 3 complete tuple mappings.");
      expect(await retrievalCount()).toBe(1);
      const committedWorkspace = (await projectState(page)).workspace;
      await batch.getByRole("button", { name: "Refresh remaining review", exact: true }).click();
      await expect(queue.getByRole("button")).toHaveCount(2);
      await expect(batch).toContainText("2/2 unmatched source tuples (2 rows)");
      await expect(queue.getByRole("button").filter({ hasText: "pending ·" })).toHaveCount(2);
      for (const guard of [regionGuard, thirdGuard]) {
        await expect(queue.getByRole("button").filter({ hasText: tupleLabel(guard) })).toHaveCount(1);
      }
      for (const source of sources) {
        await expect(queue.getByRole("button").filter({ hasText: tupleLabel(source) })).toHaveCount(0);
      }
      await expect(batch.getByRole("button", { name: "Write Mapping (0)", exact: true })).toBeDisabled();
      await expect(batch.getByRole("button", { name: "Refresh remaining review", exact: true })).toHaveCount(0);
      await expect(batch.getByRole("button", { name: /^Undo bulk acceptance/ })).toHaveCount(0);
      for (const radio of await batch.getByRole("radio").all()) await expect(radio).not.toBeChecked();
      expect(await retrievalCount()).toBe(2);
      expect(requests).toHaveLength(1); // Refresh never asks the model implicitly.
      expect((await projectState(page)).workspace).toEqual(committedWorkspace);
      expect(await execute(page)).toEqual(expected);
      await page.evaluate(p => (window as any).__dwhE2eSaveProject(p), savedPath);
      await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
      expect(saved.workspace.key_maps).toHaveLength(1);
      const map = saved.workspace.key_maps[0];
      expect(map.from_columns).toEqual(leftOn.map((c, i) => `from_${i + 1}_${c}`));
      expect(map.output_columns).toEqual(rightOn.map((c, i) => `to_${i + 1}_${c}`));
      expect(map.entries).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const entry = map.entries.find((e: any) => JSON.stringify(e.from_parts) === JSON.stringify(sources[i]));
        expect(entry?.output_values).toEqual(targets[i]);
      }
      expect(saved.workspace.queries[0].steps.map((s: any) => s.type)).toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
      expect(saved.workspace.queries[0].steps[2].payload).toEqual(project.workspace.queries[0].steps[1].payload);
      await page.screenshot({ path: info.outputPath(`batch-${width}-committed.png`) });
      await closeIsolatedSession(session); session = undefined;
      session = await launchApp(); page = session.page;
      await page.setViewportSize({ width: 1700, height: 1200 });
      await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), savedPath);
      await expect.poll(async () => (await projectState(page)).root_path).toBe(savedPath);
      expect(await execute(page)).toEqual(expected);
      expect((await projectState(page)).workspace.key_maps).toEqual(saved.workspace.key_maps);
      await page.screenshot({ path: info.outputPath(`batch-${width}-cold-reopened.png`) });
    } finally {
      await closeIsolatedSession(session);
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
