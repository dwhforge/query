import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";



// Real Electron, CSV, sidecar retrieval/scoring, Apply, Save and cold execution.
// Only the external model is replaced, by an actual loopback HTTP provider.
async function projectState(page: Page) {
  return page.evaluate(() => (window as any).__dwhE2eGetProject());
}

async function executeOnce(page: Page) {
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

async function execute(page: Page) {
  // Initial UI preview and this independent execution share the existing Host
  // lane. Retry only explicit supersession, never SQL/Apply/validation failures.
  for (let attempt = 0; ; attempt++) {
    try { return await executeOnce(page); }
    catch (e) {
      if (attempt >= 5 || !String(e).includes("Preview superseded")) throw e;
      await page.waitForTimeout(200);
    }
  }
}

for (const width of [1, 2, 3, 4, 5]) {
  test(`Unified Matching Basic ${width}-key real fuzzy + LLM, atomic write and cold Save/Reopen`, async ({}, info) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-batch-ui-"));
    let session: Awaited<ReturnType<typeof launchApp>> | undefined;
    let completed = false;
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
      fs.writeFileSync(right, `target_id,partner,${[...rightOn].reverse().join(",")}\n` + targets.map((r, i) => `id${i},partner${i},${[...r].reverse().join(",")}`).join("\n") + "\n");
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
      const batch = page.locator('[data-testid="matching-workspace"]:visible');
      await expect(batch).toBeVisible();
      await expect(page.locator('[aria-label="Find Matches"]')).toHaveCount(0);
      expect(await retrievalCount()).toBe(0); // Entry does not auto-run.
      await batch.getByTestId("matching-apply-plan").click();
      const row = (parts: string[]) => batch.getByTestId(`matching-row-${JSON.stringify(parts)}`);
      await expect(batch.locator('tr[data-testid^="matching-row-"]')).toHaveCount(5);
      const sessions = () => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
      const prepared = (await sessions())[0];
      expect(prepared.plan.outputs).toEqual(rightOn);
      expect(prepared.plan.targetIdentityFields).toEqual(["target_id"]);
      expect(prepared.decisions).toEqual([]);
      expect(prepared.proposals.find((p: any) => JSON.stringify(p.mapKey) === JSON.stringify(sources[0])).affectedSourceRows).toBe(2);
      expect(await retrievalCount()).toBe(1);
      await expect(batch.getByTestId("matching-save")).toBeDisabled();
      const bulk = batch.getByRole("button", { name: /^Accept high-confidence suggestions/ });
      const bulkCount = Number((await bulk.innerText()).match(/\((\d+)\)/)![1]);
      console.log(`${width}-key real host bulk eligibility: ${bulkCount}`);
      if (bulkCount > 0) {
        await bulk.click();
        expect((await sessions())[0].decisions).toHaveLength(bulkCount);
        expect((await projectState(page)).workspace).toEqual(before);
        expect(await execute(page)).toEqual(baseline);
        await batch.getByRole("button", { name: "Undo bulk acceptance", exact: true }).click();
        expect((await sessions())[0].decisions).toEqual([]);
        await expect(bulk).toBeDisabled(); // sticky user-touched records stay excluded
      } else {
        await expect(bulk).toBeDisabled();
        info.annotations.push({ type: "bulk eligibility", description: `${width}-key real scorer: no qualifying full-ranking suggestions; no scores manufactured.` });
      }
      // Explicit reviewed bulk uses the SAME table/ledger, and is not confidence auto-accept.
      for (const i of [0, 1]) await row(sources[i]).getByRole("checkbox").check();
      await batch.getByTestId("matching-reviewed-bulk").click();
      console.log(`${width}-key reviewed bulk complete`);
      expect((await sessions())[0].decisions).toHaveLength(2);
      for (const i of [0, 1]) {
        const decision = (await sessions())[0].decisions.find((d: any) => JSON.stringify(d.mapKey) === JSON.stringify(sources[i]));
        const candidate = (await sessions())[0].candidates.find((c: any) => c.candidateId === decision.candidateId);
        expect(candidate.outputValues).toEqual(targets[i]);
      }
      await row(sources[2]).click();
      await page.evaluate(async ({ port }) => {
        const reply = await (window as any).dwh.invoke("set_llm_config", { baseUrl: `http://127.0.0.1:${port}/v1`, model: "local-batch-fixture", apiKey: "", clearApiKey: false });
        if (!reply.ok) throw new Error(JSON.stringify(reply));
      }, { port: address.port });
      await batch.getByRole("button", { name: /Hide how to match|How to match/ }).evaluate((el: HTMLButtonElement) => {
        if (el.textContent?.includes("How to match")) el.click();
      });
      await batch.getByRole("checkbox", { name: "Allow sending matching fields to external LLM" }).check();
      await batch.locator("textarea").fill("Review these complete tuples using the supplied migration evidence. Keep source groups independent.");
      await batch.getByTestId("matching-rank-llm").click();
      await expect(batch).toContainText("LLM alternatives merged without confirming decisions");
      console.log(`${width}-key real loopback LLM merged`);
      expect(serverErrors).toEqual([]); expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/v1/chat/completions");
      expect(requests[0].body.model).toBe("local-batch-fixture");
      const prompt = requests[0].body.messages[0].content;
      expect(prompt).toContain(JSON.stringify(sources[2]));
      expect(prompt).toContain(JSON.stringify(targets[2]));
      expect(prompt).toContain(JSON.stringify(regionGuard));
      expect(prompt).not.toContain(JSON.stringify(sources[1]));
      expect((await sessions())[0].decisions).toHaveLength(2);
      await row(regionGuard).click();
      await expect(batch.getByTestId("matching-detail")).toContainText("Second source for independent review");
      expect((await sessions())[0].decisions.some((d: any) => JSON.stringify(d.mapKey) === JSON.stringify(regionGuard))).toBe(false);
      await row(sources[2]).click();
      await expect(batch.getByTestId("matching-detail")).toContainText("llm");
      await expect(batch.getByTestId("matching-detail")).not.toContainText("INVENTED");
      await batch.getByTestId(`matching-choose-${JSON.stringify(targets[2])}`).click();
      expect((await sessions())[0].decisions).toHaveLength(3);
      expect((await projectState(page)).workspace).toEqual(before);
      expect(await execute(page)).toEqual(baseline);
      // Leaving/re-entering the tab retains its ledger; current selected step is
      // deliberately NOT a JOIN when Write Mapping resolves the original binding.
      await batch.getByTestId("matching-open-lens").click();
      await page.getByRole("separator", { name: "Show inspector", exact: true }).dblclick();
      await page.locator('[data-step-type="LoadCsv"] > [role="button"]').click();
      await page.getByRole("tab", { name: "Matching: fact → dim", exact: true }).click();
      await expect(batch).toBeVisible();
      expect((await sessions())[0].decisions).toHaveLength(3);
      console.log(`${width}-key tab retention and original-JOIN navigation complete`);
      await page.evaluate(() => {
        const w = window as any; w.__batchSnapshots = [];
        w.__batchTimer = setInterval(() => {
          const ws = w.__dwhE2eGetProject().workspace;
          w.__batchSnapshots.push([ws.key_maps.length, ws.key_maps[0]?.entries.length ?? 0,
            ws.queries[0].steps.filter((s: any) => s.type === "ApplyKeyMap").length]);
        }, 0);
      });
      await batch.getByTestId("matching-save").click();
      console.log(`${width}-key commit requested`);
      const receipt = batch.getByRole("region", { name: "Matching commit receipt" });
      await expect(receipt.getByRole("status")).toHaveText("Applied 3 complete tuple mappings.");
      await expect(receipt).toContainText("Previous review decisions have been cleared.");
      expect((await sessions())[0].decisions).toEqual([]);
      await expect.poll(() => execute(page)).toEqual(expected);
      expect((await projectState(page)).workspace.queries[0].steps.map((s: any) => s.type))
        .toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
      expect(await retrievalCount()).toBe(1); // Host verification is a separate read, no unsolicited rerun.
      const snapshots = await page.evaluate(() => {
        const w = window as any; clearInterval(w.__batchTimer); return w.__batchSnapshots;
      });
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) expect([[0, 0, 0], [1, 3, 1]]).toContainEqual(snapshot);
      await page.waitForTimeout(500);
      await expect(receipt.getByRole("status")).toHaveText("Applied 3 complete tuple mappings.");
      expect(await retrievalCount()).toBe(1);
      const committedWorkspace = (await projectState(page)).workspace;
      await receipt.getByRole("button", { name: "Refresh remaining review", exact: true }).click();
      await expect(batch.locator('tr[data-testid^="matching-row-"]')).toHaveCount(2);
      for (const guard of [regionGuard, thirdGuard]) await expect(row(guard)).toHaveCount(1);
      for (const source of sources) await expect(row(source)).toHaveCount(0);
      expect((await sessions())[0].decisions).toEqual([]);
      await expect(batch.getByTestId("matching-save")).toBeDisabled();
      await expect(receipt).toHaveCount(0);
      expect(await retrievalCount()).toBe(2); expect(requests).toHaveLength(1);
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
      completed = true;
    } finally {
      // Failure cleanup must not wait for the product's intentional dirty-draft
      // beforeunload warning. Successful cold-reopen still closes normally.
      if (session && !completed) {
        await info.attach("failed-matching-review", { contentType: "text/plain", body: await session.page.locator('[data-testid="matching-workspace"]:visible').innerText({ timeout: 1000 }).catch(() => "Review unavailable") });
        const diagnostic = await session.page.evaluate(async () => {
          const w = window as any, s = w.__dwhE2eGetMatchingSessions()[0], p = w.__dwhE2eGetProject();
          if (!s?.basicRun) return "No actionable run";
          const reply = await w.dwh.invoke("join_key_fuzzy_suggest", { workspace: p.workspace, connections: p.connections,
            sources: p.sources, projectFile: p.root_path, hostQueryId: s.joinBinding.hostQueryId, joinStepIndex: s.joinBinding.joinStepIndex, tuple: {} });
          if (!reply.ok) return JSON.stringify(reply);
          const differences: string[] = [];
          const compare = (a: any, b: any, path: string) => {
            if (a === b) return;
            if (a && b && typeof a === "object" && typeof b === "object") {
              for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], `${path}.${key}`);
            } else differences.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
          };
          compare(s.basicRun.report, reply.result.tuple_report, "report");
          return differences.length ? differences.slice(0, 12).join("\n") : "Fresh and retained reports are equal as JavaScript values";
        }).catch(String);
        console.log(`Failure-only tuple evidence diagnostic: ${diagnostic}`);
        await session.app.evaluate(({ app }) => { app.quit(); app.exit(0); }).catch(() => {});
      }
      await closeIsolatedSession(session);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
