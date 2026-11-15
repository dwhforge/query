import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";

// ADR-0051 Phase 3 — Advanced LIVE integration, end-to-end.
// Real Electron, real DuckDB, real Host `matching_acquire_join` /
// `matching_verify_join_candidates` (reacquisition, NOT Basic fuzzy).
//
// The left JOIN keys are deliberately NOT equal to the right keys (aliases/
// typos), so the pre-write Join is empty and Advanced matching must recover the
// real correspondences from extra, non-key fields:
//   - soft signal  name_soft (= lower(company), a DERIVE step, absent from the
//     raw LoadCsv) <-> legal_name      -> proves acquisition reads the post-
//     derive pre-JOIN left, not the raw CSV;
//   - hard         country            <-> nation       -> filters candidates;
//   - reference    category           <-> state        -> non-filtering, unscored.
//
// Covers: bounded acquisition of actual fields, hard/soft/reference semantics,
// per-source field-score evidence + derived source values, identity-vs-output
// distinction, semantic plan-edit invalidation + explicit rerun, tab retention,
// honest confidence-bulk block, Advanced LLM rank on the verified snapshot
// (real loopback host intake, no auto-confirm, no fixture leak), verified Host
// reacquisition write (receipt/ack), atomic ApplyKeyMap+Join, real execution,
// Save and cold-process reopen.
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
  for (let attempt = 0; ; attempt++) {
    try { return await executeOnce(page); }
    catch (e) {
      if (attempt >= 5 || !String(e).includes("Preview superseded")) throw e;
      await page.waitForTimeout(200);
    }
  }
}

test("Advanced LIVE: real pre-JOIN derive field, hard/soft/reference semantics, plan-rerun, retention, bulk-blocked, verified write, execute, cold reopen", async ({}, info) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-adv-ui-"));
  let session: Awaited<ReturnType<typeof launchApp>> | undefined;
  let completed = false;
  const requests: { url?: string; body: any }[] = [];
  const serverErrors: string[] = [];
  let llmResponse: string | null = null;

  const leftOn = ["company"];
  const rightOn = ["legal_name"];
  // Left (row_id, company, country, category). company values are ALIASES that
  // do not equal the right legal_name, so the raw Join is empty.
  const leftRows = [
    ["row0", "acme corp", "us", "online"],
    ["row1", "beacon ind", "us", "wholesale"],
    ["row2", "gamma llc", "ca", "retail"],
    // Ambiguous residue: hard-eligible on us (id0+id1), soft 0.85 to both.
    ["row3", "acme beacon", "us", "online"],
  ];
  // Right (target_id, legal_name, nation, state, partner).
  const rightRows = [
    ["id0", "acme", "us", "retail", "p0"],
    ["id1", "beacon", "us", "digital", "p1"],
    ["id2", "gamma", "ca", "retail", "p2"],
    ["id3", "delta", "uk", "digital", "p3"],
  ];
  const partnerForLegal = (legal: string) =>
    rightRows.find((r) => r[1] === legal)?.[4] ?? null;
  // row0->acme(p0), row1->beacon(p1), row2->gamma(p2); row3 left unwritten -> null.
  const expected = [
    ["row0", "p0"], ["row1", "p1"], ["row2", "p2"], ["row3", null],
  ];
  const baseline = leftRows.map((r) => [r[0], null]);
  const matchedLegal: Record<string, string> = {
    "acme corp": "acme", "beacon ind": "beacon", "gamma llc": "gamma",
  };

  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: llmResponse ?? "```json\n[]\n```" } }] }));
    } catch (e) {
      serverErrors.push(String(e));
      res.writeHead(500); res.end("Fixture server failure");
    }
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    const left = path.join(dir, "left.csv"), right = path.join(dir, "right.csv");
    fs.writeFileSync(left, "row_id,company,country,category\n" + leftRows.map((r) => r.join(",")).join("\n") + "\n");
    fs.writeFileSync(right, "target_id,legal_name,nation,state,partner\n" + rightRows.map((r) => r.join(",")).join("\n") + "\n");

    const project = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
    // fact: LoadCsv -> DeriveColumn(name_soft) -> Join. name_soft is NOT a
    // LoadCsv column, so acquisition must read the post-derive pre-JOIN left.
    project.workspace = { focus_query_id: "fact", key_maps: [], queries: [
      { id: "fact", name: "fact", execution: "local", steps: [
        { type: "LoadCsv", payload: { path: left } },
        { type: "DeriveColumn", payload: { name: "name_soft", expression: "lower(company)", mode: "sql" } },
        { type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: leftOn, right_on: rightOn } },
      ] },
      { id: "dim", name: "dim", execution: "local", steps: [{ type: "LoadCsv", payload: { path: right } }] },
    ] };
    const input = path.join(dir, "input.dwhproj.json"), savedPath = path.join(dir, "saved.dwhproj.json");
    fs.writeFileSync(input, JSON.stringify(project));
    session = await launchApp();
    let { page } = session;
    await page.setViewportSize({ width: 1700, height: 1200 });
    await page.evaluate((p) => (window as any).__dwhE2eOpenProject(p), input);
    await expect(page.getByRole("heading", { name: "fact", exact: true })).toBeVisible();
    expect(await execute(page)).toEqual(baseline); // raw Join is empty
    const before = (await projectState(page)).workspace;

    // Count real Host Advanced acquisitions + verifications (delegating spy).
    await session.app.evaluate(({ ipcMain }) => {
      const state = globalThis as any;
      state.__advAcquire = 0; state.__advVerify = 0;
      const handler = (ipcMain as any)._invokeHandlers.get("dwh:invoke");
      if (!handler) throw new Error("Real dwh:invoke handler is missing");
      ipcMain.removeHandler("dwh:invoke");
      ipcMain.handle("dwh:invoke", async (event, command, ...args) => {
        if (command === "matching_acquire_join") state.__advAcquire++;
        if (command === "matching_verify_join_candidates") state.__advVerify++;
        return handler(event, command, ...args);
      });
    });
    const acquireCount = () => session!.app.evaluate(() => (globalThis as any).__advAcquire as number);
    const verifyCount = () => session!.app.evaluate(() => (globalThis as any).__advVerify as number);

    await page.locator('[data-step-type="Join"] > [role="button"]').click();
    const lens = page.getByRole("button", { name: "Join Lens", exact: true });
    if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
    const gotIt = page.getByRole("button", { name: "Got it", exact: true });
    if (await gotIt.isVisible()) await gotIt.click();
    await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();

    await page.getByRole("button", { name: "Find Matches", exact: true }).click();
    const batch = page.locator('[data-testid="matching-workspace"]:visible');
    await expect(batch).toBeVisible();
    await expect(page.locator('[aria-label="Find Matches"]')).toHaveCount(0);
    expect(await acquireCount()).toBe(0); // Entry does not auto-run.
    const sessions = () => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());

    // ---- Open the plan editor (collapsed by default for a JOIN session) ----
    await batch.locator("details summary", { hasText: "Edit plan" }).click();
    await expect(batch.locator('label:has-text("Source field") input').first()).toBeVisible();

    // ---- Build the Advanced plan: lock keys/outputs, add hard/soft/reference ----
    const srcInputs = batch.locator('label:has-text("Source field") input');
    const tgtInputs = batch.locator('label:has-text("Target field") input');
    const roleSelects = batch.locator('label:has-text("How to use") select');
    const removeCompare = batch.getByRole("button", { name: "Remove comparison" });
    const addCompare = () => batch.getByRole("button", { name: "Compare another field" });

    // Comparison 0: name_soft (DERIVED) <-> legal_name, soft (default role).
    await srcInputs.nth(0).fill("name_soft");
    expect(await tgtInputs.nth(0).inputValue()).toBe("legal_name");
    // Comparison 1: country <-> nation, hard.
    await addCompare().click();
    await srcInputs.nth(1).fill("country");
    await tgtInputs.nth(1).fill("nation");
    await roleSelects.nth(1).selectOption("hard_constraint");
    // Comparison 2: category <-> state, reference (hint only, non-filtering).
    await addCompare().click();
    await srcInputs.nth(2).fill("category");
    await tgtInputs.nth(2).fill("state");
    await roleSelects.nth(2).selectOption("reference_context");

    const planned = (await sessions())[0];
    expect(planned.plan.mapKeyFields).toEqual(["company"]); // locked left key
    expect(planned.plan.outputs).toEqual(["legal_name"]); // locked right output
    expect(planned.plan.targetIdentityFields).toEqual(["target_id"]);
    expect(planned.plan.normalization).toEqual(["trim", "casefold"]);
    expect(planned.plan.comparisons.map((c: any) => [c.sourceField, c.targetField, c.role])).toEqual([
      ["name_soft", "legal_name", "soft_signal"],
      ["country", "nation", "hard_constraint"],
      ["category", "state", "reference_context"],
    ]);
    // The plan is no longer the Basic shape, but keeps the original JOIN shape.
    expect(await batch.getByTestId("matching-apply-plan").isEnabled()).toBe(true);

    // ---- Run Advanced (explicit Find matches) ----
    await batch.getByTestId("matching-apply-plan").click();
    await expect(batch.getByTestId("matching-advanced-coverage")).toBeVisible({ timeout: 30_000 })
      .catch(async () => {
        const errText = await batch.innerText().catch(() => "");
        throw new Error("Advanced run did not produce live evidence. UI text:\n" + errText.slice(-1500));
      }); // run finished
    expect(await acquireCount()).toBe(1); // exactly one real Host acquisition
    let s = (await sessions())[0];
    expect(s.matchingMode).toBe("advanced");
    expect(!!s.advancedRun).toBe(true);
    // Locked JOIN shape retained on the acquired plan; extra fields acquired.
    expect(s.advancedRun.snapshot.plan.mapKeyFields).toEqual(["company"]);
    expect(s.advancedRun.snapshot.plan.outputs).toEqual(["legal_name"]);
    expect(s.advancedRun.snapshot.acquisition.sourceFields.slice().sort()).toEqual(["category", "company", "country", "name_soft"]);
    expect(s.advancedRun.snapshot.acquisition.complete).toBe(true);
    // 4 distinct source keys, one per left row.
    expect(s.proposals).toHaveLength(4);
    const row = (company: string) => s.proposals.find((p: any) => p.mapKey[0] === company)!;
    const cand = (legalName: string) => s.candidates.find((c: any) => c.fields?.legal_name === legalName)!;

    // Derived field present in the acquired source values (not in the LoadCsv).
    expect(row("acme corp").sourceValues.name_soft).toBe("acme corp");
    expect(row("acme corp").sourceValues.country).toBe("us");
    // fieldScores ordered by comparisons: [soft≈0.95, hard=null, reference=null].
    const e0 = row("acme corp").edges!;
    expect(e0).toHaveLength(1); // shortlist: id0 only (beacon scored 0.0)
    expect(e0[0].fieldScores[0]).toBeGreaterThanOrEqual(0.9); // soft scored
    expect(e0[0].fieldScores[1]).toBeNull(); // hard unscored
    expect(e0[0].fieldScores[2]).toBeNull(); // reference unscored
    expect(e0[0].score).toBeGreaterThanOrEqual(0.9);
    // Proposed is the soft winner "acme"; identity is distinct from the output.
    expect(cand("acme").identityParts).toEqual(["id0"]);
    expect(cand("acme").outputValues).toEqual(["acme"]);
    const prop0 = row("acme corp").proposedCandidateId!;
    expect(s.candidates.find((c: any) => c.candidateId === prop0)!.fields.legal_name).toBe("acme");

    // row2 (ca): the hard constraint filtered out every us target -> only "gamma".
    // alternativeCandidateIds is the full shortlist (proposed included, by adapter design).
    const prop2 = row("gamma llc");
    expect(prop2.alternativeCandidateIds).toHaveLength(1);
    expect(s.candidates.find((c: any) => c.candidateId === prop2.alternativeCandidateIds[0])!.fields.legal_name).toBe("gamma");

    // reference is non-filtering: row0 category="online" != id0 state="retail"
    // yet id0 is proposed (reference neither filters nor scores).
    expect(s.candidates.find((c: any) => c.candidateId === row("acme corp").proposedCandidateId)!.fields.state).toBe("retail");
    expect(row("acme corp").sourceValues.category).toBe("online");

    // ---- Confidence bulk is honestly BLOCKED (bounded shortlist != full universe) ----
    await batch.getByText("Review actions — explicit counted bulk", { exact: true }).click();
    const bulk = batch.getByRole("button", { name: /^Accept high-confidence suggestions/ });
    const bulkCount = Number((await bulk.innerText()).match(/\((\d+)\)/)![1]);
    expect(bulkCount).toBe(0);
    await expect(bulk).toBeDisabled(); // unknown competitors -> no manufactured confidence
    info.annotations.push({ type: "advanced bulk", description: `honest block: ${bulkCount} eligible (bounded shortlist, 4 right rows)` });

    // ---- Plan-change invalidation: remove a comparison (semantic) -> no auto rerun ----
    await removeCompare.nth(2).click(); // drop the reference comparison
    s = (await sessions())[0];
    expect(s.plan.comparisons).toHaveLength(2); // soft + hard remain
    expect(s.proposals).toHaveLength(0); // run invalidated
    expect(s.advancedRun).toBeUndefined();
    expect(await acquireCount()).toBe(1); // the edit alone never re-runs
    // Explicit Find matches re-runs a FRESH acquisition.
    await batch.getByTestId("matching-apply-plan").click();
    await expect(batch.getByTestId("matching-advanced-coverage")).toBeVisible(); // run finished
    expect(await acquireCount()).toBe(2);
    s = (await sessions())[0];
    expect(!!s.advancedRun).toBe(true);
    expect(s.proposals).toHaveLength(4);
    // name_soft is still soft: scored; the reference comparison is gone.
    const e0b = row("acme corp").edges!;
    expect(e0b[0].fieldScores).toHaveLength(2);
    expect(e0b[0].fieldScores[0]).toBeGreaterThanOrEqual(0.9);
    expect(e0b[0].fieldScores[1]).toBeNull(); // hard

    // ---- Confirm the 3 clear rows (reviewed bulk), leaving the ambiguous residue ----
    const checkRow = async (company: string) => {
      const r = (await sessions())[0].proposals.find((p: any) => p.mapKey[0] === company)!;
      await batch.getByTestId(`matching-row-${r.proposalId}`).getByRole("checkbox").check();
    };
    for (const c of ["acme corp", "beacon ind", "gamma llc"]) await checkRow(c);
    await batch.getByText("Review actions — explicit counted bulk", { exact: true }).click();
    await batch.getByTestId("matching-reviewed-bulk").click();
    s = (await sessions())[0];
    expect(s.decisions).toHaveLength(3);
    expect(await verifyCount()).toBe(0); // confirm is a local decision, not a write
    expect((await projectState(page)).workspace).toEqual(before);
    expect(await execute(page)).toEqual(baseline); // nothing written yet

    // ---- Advanced LLM rank against the verified snapshot (real loopback) ----
    // Only the ambiguous residue ("acme beacon") remains for the model.
    const residue = s.proposals.find((p: any) => p.mapKey[0] === "acme beacon")!;
    const beaconCand = s.candidates.find((c: any) => c.fields?.legal_name === "beacon")!;
    const allowlistTargets = (residue.alternativeCandidateIds as string[])
      .map((cid) => s.candidates.find((c: any) => c.candidateId === cid)!.targetId);
    expect(new Set(allowlistTargets).size).toBeGreaterThanOrEqual(2); // ambiguous residue
    await page.evaluate(async ({ port }) => {
      const reply = await (window as any).dwh.invoke("set_llm_config", { baseUrl: `http://127.0.0.1:${port}/v1`, model: "local-adv-fixture", apiKey: "", clearApiKey: false });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
    }, { port: address.port });
    await batch.getByRole("button", { name: /Hide how to match|How to match/ }).evaluate((el: HTMLButtonElement) => {
      if (el.textContent?.includes("How to match")) el.click();
    });
    await batch.getByRole("checkbox", { name: "Allow sending matching fields to external LLM" }).check();
    await batch.locator("textarea").fill("Match by company and country. Prefer the same nation.");
    llmResponse = "```json\n" + JSON.stringify([
      { proposalId: residue.proposalId, targetId: beaconCand.targetId, confidence: "high", why: "same nation and name" },
    ]) + "\n```";
    await batch.getByTestId("matching-rank-llm").click();
    await expect(batch).toContainText(/LLM done: ranked 1\/1/); // 1 residue row, 1 pick
    expect(serverErrors).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe("local-adv-fixture");
    const userMsg = requests[0].body.messages[1]?.content ?? "";
    expect(userMsg).toContain("name_soft"); // real acquired snapshot field, not a fixture
    expect(userMsg).toContain("acme beacon"); // derived value present in the prompt
    // Parse the rank prompt body and assert on the OFFERED allowlist (escaping-
    // independent). The verified-snapshot allowlist must include the residue's
    // allowlisted target and must NEVER include the hard-filtered id3 (delta/uk) —
    // the model is only offered the bounded snapshot, not the full right.
    const body = userMsg.slice(userMsg.indexOf("{"), userMsg.lastIndexOf("}") + 1);
    const rankBody = JSON.parse(body);
    const offeredTargetIds = rankBody.proposals.flatMap((p: any) => p.candidates.map((c: any) => c.targetId));
    expect(offeredTargetIds).toContain(beaconCand.targetId); // residue allowlist offered
    expect(offeredTargetIds).not.toContain('["id3"]'); // hard-filtered never offered
    // LLM does not auto-confirm (only the 3 explicit decisions exist).
    expect((await sessions())[0].decisions).toHaveLength(3);
    // The pick changed the residue proposal to "beacon".
    const residueAfter = (await sessions())[0].proposals.find((p: any) => p.mapKey[0] === "acme beacon")!;
    expect((await sessions())[0].candidates.find((c: any) => c.candidateId === residueAfter.proposedCandidateId)!.fields.legal_name).toBe("beacon");
    llmResponse = null;

    // ---- Tab retention: leave, switch to a non-JOIN step, return ----
    await batch.getByTestId("matching-open-lens").click();
    await page.getByRole("separator", { name: "Show inspector", exact: true }).dblclick();
    await page.locator('[data-step-type="LoadCsv"] > [role="button"]').click();
    await page.getByRole("tab", { name: "Matching: fact \u2192 dim", exact: true }).click();
    await expect(batch).toBeVisible();
    expect((await sessions())[0].decisions).toHaveLength(3); // ledger retained

    // ---- Verified write: Host reacquisition (NOT Basic fuzzy), atomic apply ----
    await page.evaluate(() => {
      const w = window as any; w.__advSnapshots = [];
      w.__advTimer = setInterval(() => {
        const ws = w.__dwhE2eGetProject().workspace;
        w.__advSnapshots.push([ws.key_maps.length, ws.key_maps[0]?.entries.length ?? 0,
          ws.queries[0].steps.filter((x: any) => x.type === "ApplyKeyMap").length]);
      }, 0);
    });
    await batch.getByTestId("matching-save").click();
    const receipt = batch.getByRole("region", { name: "Matching commit receipt" });
    await expect(receipt.getByRole("status")).toHaveText("Applied 3 complete tuple mappings.");
    await expect(receipt).toContainText("Previous review decisions have been cleared.");
    expect((await sessions())[0].decisions).toEqual([]);
    expect(await verifyCount()).toBe(1); // Advanced verification ran (reacquisition)
    // The verify's re-acquisition is host-internal (not a separate renderer IPC);
    // the renderer spy only saw the two explicit Find-matches acquisitions.
    expect(await acquireCount()).toBe(2);
    await expect.poll(() => execute(page)).toEqual(expected);
    expect((await projectState(page)).workspace.queries[0].steps.map((x: any) => x.type))
      .toEqual(["LoadCsv", "DeriveColumn", "ApplyKeyMap", "Join"]);
    const snapshots = await page.evaluate(() => {
      const w = window as any; clearInterval(w.__advTimer); return w.__advSnapshots;
    });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) expect([[0, 0, 0], [1, 3, 1]]).toContainEqual(snap);

    // ---- Explicit refresh: re-runs Advanced on the committed context ----
    // The 3 confirmed keys are now JOIN-matched (out of the unmatched scope), so
    // only the open residue ("acme beacon") re-acquires. This is a NEW Advanced run.
    await receipt.getByRole("button", { name: "Refresh remaining review", exact: true }).click();
    await expect(batch.getByTestId("matching-advanced-coverage")).toBeVisible(); // re-run finished
    expect(await acquireCount()).toBe(3); // 2 runs + 1 explicit refresh re-acquisition
    const afterRefresh = (await sessions())[0];
    expect(!!afterRefresh.advancedRun).toBe(true); // a fresh Advanced run, not Basic
    const refreshed = afterRefresh.proposals.find((p: any) => p.mapKey[0] === "acme beacon");
    expect(!!refreshed).toBe(true); // open residue retained after commit
    expect(afterRefresh.proposals.find((p: any) => p.mapKey[0] === "acme corp")).toBeUndefined(); // matched rows gone
    expect(await execute(page)).toEqual(expected);

    // ---- Save + cold reopen ----
    await page.evaluate((p) => (window as any).__dwhE2eSaveProject(p), savedPath);
    await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    const map = saved.workspace.key_maps[0];
    expect(map.from_columns).toEqual(["from_1_company"]);
    expect(map.output_columns).toEqual(["to_1_legal_name"]);
    expect(map.entries).toHaveLength(3);
    for (const c of ["acme corp", "beacon ind", "gamma llc"]) {
      const entry = map.entries.find((e: any) => JSON.stringify(e.from_parts) === JSON.stringify([c]));
      expect(entry).toBeTruthy();
      expect(entry.output_values).toEqual([matchedLegal[c]]); // matched RIGHT value
    }
    expect(saved.workspace.queries[0].steps.map((x: any) => x.type))
      .toEqual(["LoadCsv", "DeriveColumn", "ApplyKeyMap", "Join"]);
    expect(partnerForLegal("delta")).toBe("p3"); // sanity: unmapped right row exists

    await page.screenshot({ path: info.outputPath("advanced-committed.png") });
    await closeIsolatedSession(session); session = undefined;
    session = await launchApp(); page = session.page;
    await page.setViewportSize({ width: 1700, height: 1200 });
    await page.evaluate((p) => (window as any).__dwhE2eOpenProject(p), savedPath);
    await expect.poll(async () => (await projectState(page)).root_path).toBe(savedPath);
    expect(await execute(page)).toEqual(expected);
    expect((await projectState(page)).workspace.key_maps).toEqual(saved.workspace.key_maps);
    await page.screenshot({ path: info.outputPath("advanced-cold-reopened.png") });
    completed = true;
  } finally {
    if (session && !completed) {
      await info.attach("failed-advanced-review", { contentType: "text/plain", body: await session.page.locator('[data-testid="matching-workspace"]:visible').innerText({ timeout: 1000 }).catch(() => "Review unavailable") });
      await session.app.evaluate(({ app }) => { app.quit(); app.exit(0); }).catch(() => {});
    }
    await closeIsolatedSession(session);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
