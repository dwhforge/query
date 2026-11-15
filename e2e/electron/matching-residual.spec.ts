import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchApp, closeIsolatedSession } from "./helpers/launch.mjs";

type Session = Awaited<ReturnType<typeof launchApp>>;
const getProject = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetProject());
const getSessions = (page: Page) => page.evaluate(() => (window as any).__dwhE2eGetMatchingSessions());
const review = (page: Page) => page.locator('[data-testid="matching-workspace"]:visible');

async function setup(advanced: boolean, many = false, exported = false, emptySoft = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwh-residual-"));
  const left = path.join(dir, "left.csv"), right = path.join(dir, "right.csv");
  fs.writeFileSync(left, `row_id,company,country\nr0,${emptySoft ? "OpaqueSource" : "Acme Ltd"},UK\n`);
  const records = many ? Array.from({ length: 55 }, (_, i) => [`id${i}`, `Acme ${i}`, "UK", `p${i}`]) : [["id0", "Acme", "UK", "p0"]];
  records.push(["wanted", "Zebra Opaque Trading", "UK", "manual-partner"], ["forbidden", "Zebra Forbidden", "US", "wrong"]);
  fs.writeFileSync(right, "target_id,legal_name,nation,partner\n" + records.map(r => r.join(",")).join("\n") + "\n");
  const project = JSON.parse(fs.readFileSync("e2e/electron/fixtures/mapping-create/smoke.dwhproj.json", "utf8"));
  project.workspace = { focus_query_id: "fact", key_maps: [{ id: "unrelated", name: "Unrelated", storage: { kind: "seed" },
    from_columns: ["external"], output_columns: ["value"], entries: [{ from: "x", from_parts: ["x"], to: "y", output_values: ["y"] }] }], queries: [
    { id: "fact", name: "fact", execution: "local", steps: [
      { type: "LoadCsv", payload: { path: left } },
      { type: "Join", payload: { right_query_id: "dim", join_type: "left", left_on: ["company"], right_on: ["legal_name"] } }] },
    { id: "dim", name: "dim", execution: "local", steps: [{ type: "LoadCsv", payload: { path: right } }] }] };
  if (exported) {
    const out = path.join(dir, "export"); fs.mkdirSync(path.join(out, "seeds"), { recursive: true });
    fs.writeFileSync(path.join(out, "seeds", "map_unrelated.csv"), "external,value\nx,y\n");
    project.last_dbt_export_path = out;
  }
  const input = path.join(dir, "input.dwhproj.json"); fs.writeFileSync(input, JSON.stringify(project));
  const session = await launchApp(); const { page } = session;
  await page.setViewportSize({ width: 1700, height: 1200 });
  await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
  await expect(page.getByRole("heading", { name: "fact", exact: true })).toBeVisible();
  await page.locator('[data-step-type="Join"] > [role="button"]').click();
  const lens = page.getByRole("button", { name: "Join Lens", exact: true });
  if (await lens.getAttribute("aria-pressed") !== "true") await lens.click();
  const got = page.getByRole("button", { name: "Got it", exact: true }); if (await got.isVisible()) await got.click();
  await page.getByRole("separator", { name: "Resize data panel", exact: true }).dblclick();
  await page.getByRole("button", { name: "Find Matches", exact: true }).click();
  const batch = review(page);
  if (advanced) {
    await batch.locator("details summary", { hasText: "Edit plan" }).click();
    await batch.getByRole("button", { name: "Compare another field" }).click();
    await batch.locator('label:has-text("Source field") input').nth(1).fill("country");
    await batch.locator('label:has-text("Target field") input').nth(1).fill("nation");
    await batch.locator('label:has-text("How to use") select').nth(1).selectOption("hard_constraint");
  }
  await batch.getByTestId("matching-apply-plan").click();
  await expect.poll(async () => (await getSessions(page))[0]?.proposals.length).toBe(1);
  await batch.locator('tr[data-testid^="matching-row-"]').first().click();
  return { session, dir, input, batch };
}

async function confirmProposed(page: Page) {
  await review(page).getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await review(page).getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  await expect.poll(async () => (await getSessions(page))[0].decisions.length).toBe(1);
}

// Hold a REAL Host response after delegation. No synthetic retrieval/verification.
async function hold(session: Session, command: string) {
  await session.app.evaluate(({ ipcMain }, command) => {
    const w = globalThis as any;
    const original = (ipcMain as any)._invokeHandlers.get("dwh:invoke");
    w.__heldStarted = false; w.__heldSettled = false; w.__heldCount = 0;
    w.__hold = new Promise<void>(resolve => { w.__release = resolve; });
    ipcMain.removeHandler("dwh:invoke");
    ipcMain.handle("dwh:invoke", async (event, cmd, ...args) => {
      const result = await original(event, cmd, ...args);
      if (cmd === command) { w.__heldCount++; w.__heldStarted = true; await w.__hold; w.__heldSettled = true; }
      return result;
    });
  }, command);
}
async function waitHeld(session: Session) { await expect.poll(() => session.app.evaluate(() => (globalThis as any).__heldStarted)).toBe(true); }
async function release(session: Session) { await session.app.evaluate(() => (globalThis as any).__release()); }
async function dispose(session: Session, dir: string) {
  await session.app.evaluate(() => { (globalThis as any).__release?.(); }).catch(() => {});
  await session.page.evaluate(() => { (window as any).__dwhE2ePatchProject((p: any) => p);
    for (const s of (window as any).__dwhE2eGetMatchingSessions())
      (window as any).__dwhE2eOpenMatchingSession({ ...s, hasUnsavedDecisions: false });
  }).catch(() => {});
  await session.page.waitForTimeout(50).catch(() => {});
  await closeIsolatedSession(session); fs.rmSync(dir, { recursive: true, force: true });
}

for (const emptySoft of [false, true]) test(`Advanced real manual lookup beyond ${emptySoft ? "empty-soft expansion" : "40-entry"} shortlist: constraints, paging, decision, atomic write, execute and cold reopen`, async () => {
  const { session, dir, batch } = await setup(true, true, false, emptySoft); let reopened: Session | undefined;
  try {
    const { page } = session; const before = (await getProject(page)).workspace;
    const s = (await getSessions(page))[0];
    const wanted = s.candidates.find((c: any) => c.identityParts[0] === "wanted");
    expect(s.proposals[0].alternativeCandidateIds).not.toContain(wanted.candidateId);
    await batch.getByText("Search other records", { exact: true }).evaluate(el => { (el.parentElement as HTMLDetailsElement).open = true; });
    const search = batch.getByRole("region", { name: "Manual right search" });
    await search.getByTestId("matching-advanced-lookup").click();
    await expect(search).toContainText("56 admissible matches");
    await search.getByRole("button", { name: "Next lookup page" }).click();
    await expect(search).toContainText("Host page 2");
    await search.getByRole("searchbox").fill("Zebra");
    await search.getByTestId("matching-advanced-lookup").click();
    await expect(search).toContainText("1 admissible matches");
    await expect(search.getByRole("radio")).toHaveCount(1);
    await expect(search).not.toContainText("Zebra Forbidden");
    await expect(search).toContainText("mean 0.0%");
    await search.getByRole("radio").check();
    expect((await getSessions(page))[0].decisions).toHaveLength(0);
    await search.getByRole("button", { name: "Inspect RIGHT relationships", exact: true }).click();
    await expect(batch.getByRole("region", { name: "RIGHT relationship explorer" })).toContainText("LEFT records related to this RIGHT");
    await batch.getByRole("button", { name: "Select this relationship for inspection", exact: true }).click();
    expect((await getSessions(page))[0].decisions).toHaveLength(0);
    await page.getByRole("button", { name: "Confirm selected candidate" }).click();
    const accepted = (await getSessions(page))[0];
    expect(accepted.decisions).toHaveLength(1);
    expect(accepted.proposals[0].manualLookups[wanted.candidateId]).toEqual({ text: "Zebra", offset: 0 });
    expect((await getProject(page)).workspace).toEqual(before);
    await batch.getByTestId("matching-save").click();
    await expect(batch.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings.");
    const after = await getProject(page);
    expect(after.workspace.key_maps.flatMap((m: any) => m.entries).some((e: any) => e.output_values?.[0] === "Zebra Opaque Trading")).toBe(true);
    expect(after.workspace.queries[0].steps.map((x: any) => x.type)).toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
    const execute = async (p: Page) => p.evaluate(async () => {
      const w = window as any, project = w.__dwhE2eGetProject();
      const reply = await w.dwh.invoke("preview_workspace", { workspace: project.workspace, connections: project.connections, sources: project.sources, projectFile: project.root_path, projectUid: project.project_uid, rowLimit: 50 });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
      return reply.result.rows[0][reply.result.columns.findIndex((c: any) => c.name === "partner")];
    });
    await expect.poll(() => execute(page)).toBe("manual-partner");
    const saved = path.join(dir, "saved.dwhproj.json");
    await page.evaluate(p => (window as any).__dwhE2eSaveProject(p), saved);
    await closeIsolatedSession(session);
    reopened = await launchApp();
    await reopened.page.evaluate(p => (window as any).__dwhE2eOpenProject(p), saved);
    await expect.poll(async () => (await getProject(reopened!.page)).root_path).toBe(saved);
    await expect.poll(() => execute(reopened!.page)).toBe("manual-partner");
    expect((await getProject(reopened.page)).workspace.key_maps).toEqual(after.workspace.key_maps);
  } finally { if (reopened) await dispose(reopened, dir); else await dispose(session, dir); }
});

for (const mutation of ["query", "context-aba"] as const) {
  test(`Advanced real lookup: late ${mutation} response never registers or confirms a candidate`, async () => {
    const { session, dir, batch } = await setup(true);
    try {
      const { page } = session; const before = (await getProject(page)).workspace;
      await batch.getByText("Search other records", { exact: true }).evaluate(el => { (el.parentElement as HTMLDetailsElement).open = true; });
      const search = batch.getByRole("region", { name: "Manual right search" });
      await search.getByRole("searchbox").fill("Zebra");
      await hold(session, "matching_lookup_join_candidates");
      await search.getByTestId("matching-advanced-lookup").click(); await waitHeld(session);
      if (mutation === "query") await search.getByRole("searchbox").fill("no-such-record");
      else {
        await page.evaluate(() => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: { ...p.workspace,
          queries: p.workspace.queries.map((q: any) => q.id !== "fact" ? q : { ...q, steps: [q.steps[0],
            { type: "Filter", payload: { condition: "true" } }, ...q.steps.slice(1)] }) } })));
        await expect.poll(async () => (await getSessions(page))[0]?.commitLifecycle?.status).toBe("stale");
        await page.evaluate(ws => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: ws })), before);
        await expect.poll(async () => (await getProject(page)).workspace).toEqual(before);
      }
      await release(session);
      await expect.poll(() => session.app.evaluate(() => (globalThis as any).__heldSettled)).toBe(true);
      await page.waitForTimeout(150);
      expect((await getSessions(page))[0].decisions).toHaveLength(0);
      expect((await getSessions(page))[0].proposals[0].manualLookups).toBeUndefined();
      if (mutation === "query") await expect(search).not.toContainText("admissible matches");
      else await expect(search).toHaveCount(0); // stale row leaves the active filter/detail
      expect((await getProject(page)).workspace).toEqual(before);
      if (mutation === "query") {
        await search.getByTestId("matching-advanced-lookup").click();
        await expect(search).toContainText("0 admissible matches");
      }
    } finally { await dispose(session, dir); }
  });
}

for (const advanced of [false, true]) for (const mutation of ["delete-join", "upstream", "project-aba", "context-aba"] as const) {
  test(`${advanced ? "Advanced" : "Basic"} real App: ${mutation} during held Host verification never publishes Mapping or Apply`, async () => {
    const { session, dir, batch, input } = await setup(advanced);
    try {
      const { page } = session; await confirmProposed(page);
      const before = await getProject(page);
      await hold(session, advanced ? "matching_verify_join_candidates" : "matching_verify_join_tuples");
      await batch.getByTestId("matching-save").click(); await waitHeld(session);
      if (mutation === "project-aba") {
        const other = path.join(dir, "other.dwhproj.json");
        fs.writeFileSync(other, JSON.stringify({ ...before, project_uid: "other-project", name: "other" }));
        await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), other);
        await expect.poll(async () => (await getProject(page)).project_uid).toBe("other-project");
        await page.evaluate(p => (window as any).__dwhE2eOpenProject(p), input);
        await expect.poll(async () => (await getProject(page)).project_uid).toBe(before.project_uid);
      } else {
        await page.evaluate(m => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: { ...p.workspace,
          queries: p.workspace.queries.map((q: any) => q.id !== "fact" ? q : { ...q, steps: m === "delete-join"
            ? q.steps.filter((s: any) => s.type !== "Join") : [q.steps[0], { type: "Filter", payload: { condition: "true" } }, ...q.steps.slice(1)] }) } })), mutation);
        await expect.poll(async () => (await getSessions(page))[0]?.commitLifecycle?.status).toBe("stale");
        if (mutation === "context-aba") {
          await page.evaluate(ws => (window as any).__dwhE2ePatchProject((p: any) => ({ ...p, workspace: ws })), before.workspace);
          await expect.poll(async () => (await getProject(page)).workspace).toEqual(before.workspace);
        }
      }
      const expected = (await getProject(page)).workspace;
      await release(session);
      await expect.poll(() => session.app.evaluate(() => (globalThis as any).__heldSettled)).toBe(true);
      await page.waitForTimeout(150);
      expect((await getProject(page)).workspace).toEqual(expected);
      expect(expected.key_maps).toEqual(before.workspace.key_maps);
      expect(expected.queries[0].steps.some((s: any) => s.type === "ApplyKeyMap")).toBe(false);
      await expect(page.getByRole("region", { name: "Matching commit receipt" })).toHaveCount(0);
    } finally { await dispose(session, dir); }
  });
}

for (const advanced of [false, true]) {
  test(`${advanced ? "Advanced" : "Basic"} real App: failed private Apply publishes nothing, preserves draft and retries atomically`, async () => {
    const { session, dir, batch } = await setup(advanced);
    try {
      const { page } = session; await confirmProposed(page);
      const before = (await getProject(page)).workspace, decisions = (await getSessions(page))[0].decisions;
      await page.evaluate(() => { (window as any).__dwhE2eFailTupleApply = true; });
      await batch.getByTestId("matching-save").click();
      await expect(batch).toContainText("Injected Apply preparation failure");
      expect((await getProject(page)).workspace).toEqual(before);
      expect((await getSessions(page))[0].decisions).toEqual(decisions);
      await expect(batch.getByTestId("matching-save")).toBeEnabled();
      await batch.getByTestId("matching-save").click();
      await expect(batch.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings.");
      expect((await getProject(page)).workspace.queries[0].steps.map((s: any) => s.type)).toEqual(["LoadCsv", "ApplyKeyMap", "Join"]);
    } finally { await dispose(session, dir); }
  });
}

for (const advanced of [false, true]) {
  test(`${advanced ? "Advanced" : "Basic"} real App: concurrent Mapping Save cannot overlap Matching verification`, async () => {
    const { session, dir, batch } = await setup(advanced, false, true);
    try {
      const { page } = session; await confirmProposed(page);
      const before = (await getProject(page)).workspace;
      await hold(session, "push_key_map_to_export");
      await page.evaluate(() => { const w = window as any; w.__mapSavePromise = w.__dwhE2eSaveMapping("unrelated"); });
      await waitHeld(session);
      await batch.getByTestId("matching-save").click();
      await expect(batch).toContainText(/write.*in progress|write context is unavailable/i);
      expect((await getProject(page)).workspace).toEqual(before);
      expect((await getSessions(page))[0].decisions).toHaveLength(1);
      await release(session); await page.evaluate(() => (window as any).__mapSavePromise);
      await hold(session, advanced ? "matching_verify_join_candidates" : "matching_verify_join_tuples");
      await batch.getByTestId("matching-save").click(); await waitHeld(session);
      const blocked = await page.evaluate(() => (window as any).__dwhE2eSaveMapping("unrelated"));
      expect(blocked.message).toContain("Matching write is in progress");
      expect((await getProject(page)).workspace).toEqual(before);
      await release(session);
      await expect(batch.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings.");
    } finally { await dispose(session, dir); }
  });
}
