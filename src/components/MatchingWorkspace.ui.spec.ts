import { test, expect } from "@playwright/test";
import { mount } from "./MatchingWorkspace.testHarness";

for (const width of [1, 2, 3, 4, 5]) {
  test(`${width}-key shared review: no preaccept, locked outputs, confidence bulk undo, explicit reviewed bulk and receipt`, async ({ page }) => {
    await mount(page, width);
    expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
    const s = await page.evaluate(() => (window as any).session);
    expect(s.plan.outputs).toEqual(s.joinBinding.rightOn);
    expect(s.plan.targetIdentityFields).toEqual(["target_id"]);
    await page.getByText("Edit plan — Basic locks the original JOIN keys", { exact: true }).click();
    await expect(page.getByRole("combobox").first()).toBeDisabled();
    await page.getByRole("button", { name: "Accept high-confidence suggestions (2)", exact: true }).click();
    expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(2);
    await page.getByRole("button", { name: "Undo bulk acceptance", exact: true }).click();
    expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(0);
    await expect(page.getByTestId("matching-bulk-confirm")).toBeDisabled();
    await page.getByRole("button", { name: "Check visible rows", exact: true }).click();
    await page.getByTestId("matching-reviewed-bulk").click();
    await page.getByTestId("matching-save").click();
    await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 2 complete tuple mappings.");
    expect(await page.evaluate(() => (window as any).saved[0][0].outputValues.length)).toBe(width);
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "retrieve").length)).toBe(1);
    await page.getByRole("button", { name: "Refresh remaining review" }).click();
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "retrieve").length)).toBe(2);
    expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  });
}

test("NULL values remain distinct and unsafe confirmation is disabled", async ({ page }) => {
  await mount(page, 2, { nullSource: true, incomplete: true });
  await expect(page.getByTestId("matching-detail")).toContainText("NULL");
  await expect(page.getByTestId("matching-detail")).toContainText("NULL cannot be represented");
  await expect(page.locator("button").filter({ hasText: "Use this match" })).toBeDisabled();
  await expect(page.getByTestId("matching-bulk-confirm")).toBeDisabled();
});

test("failed write retains decisions and permits retry; pending locks old rows", async ({ page }) => {
  await mount(page, 3, { failWrite: true, holdWrite: true });
  await page.getByRole("button", { name: "Use this match", exact: true }).click();
  await page.getByTestId("matching-save").click();
  await expect(page.getByTestId("matching-workspace")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Use this match", exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as any).releaseWrite(); (window as any).holdWrite = false; });
  await expect(page.getByText(/Apply refused; no publication/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(1);
  await expect(page.getByTestId("matching-save")).toBeEnabled();
  await page.evaluate(() => { (window as any).failWrite = false; });
  await page.getByTestId("matching-save").click();
  await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings.");
});

test("late LLM alternatives preserve the latest explicit decision and exact provenance", async ({ page }) => {
  await mount(page, 2);
  await page.getByRole("checkbox", { name: "Allow sending matching fields to external LLM" }).check();
  await page.getByTestId("matching-rank-llm").click();
  await expect.poll(() => page.evaluate(() => (window as any).pendingLlm.length)).toBe(1);
  await page.getByRole("button", { name: "Use this match", exact: true }).click();
  const decision = await page.evaluate(() => (window as any).session.decisions[0]);
  await page.evaluate(() => {
    const w = window as any;
    w.pendingLlm.shift().resolve({ content: JSON.stringify({ pairs: [{ from_parts: w.report.sources[0].source.parts,
      to_parts: w.report.right_universe[1].parts, why: "late competing alternative" }] }) });
  });
  await expect(page.getByTestId("matching-detail")).toContainText("late competing alternative");
  expect(await page.evaluate(() => (window as any).session.decisions[0])).toEqual(decision);
  await expect(page.getByTestId("matching-detail")).toContainText("fuzzy + llm");
});

test("Advanced live run: semantic edit confirms, disclosure never re-runs, edits invalidate, verified commit + receipt + refresh", async ({ page }) => {
  await mount(page, 2);
  // One explicit decision on the Basic proposal.
  await page.getByRole("button", { name: "Use this match", exact: true }).click();
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(1);

  // A semantic edit (comparison role) confirms the Advanced plan shape AND invalidates
  // the Basic producer run + the pending decision.
  await page.getByText("Edit plan — Basic locks the original JOIN keys", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator('section[aria-label="Matching plan"] select').nth(0).selectOption("hard_constraint");
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(0);

  // Find matches now routes to the verified Advanced acquisition (not the Basic retrieve).
  // Await the Advanced coverage signal so the async acquisition has settled before counting.
  await page.getByRole("button", { name: "1. Find matches", exact: true }).click();
  await expect(page.getByTestId("matching-advanced-coverage")).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "retrieve").length)).toBe(2);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "acquire").length)).toBe(1);
  await expect(page.locator('tr[data-testid^="matching-row-"]')).toHaveCount(1);
  let s = await page.evaluate(() => (window as any).session);
  expect(s.matchingMode).toBe("advanced");
  expect(!!s.advancedRun && !!s.advancedRun.id).toBe(true);
  const runId = s.advancedRun.id;
  // The locked JOIN key/output shape is retained; only the comparison role differs.
  expect(s.plan.mapKeyFields).toEqual(s.joinBinding.leftOn);
  expect(s.plan.outputs).toEqual(s.joinBinding.rightOn);

  // Disclosure-only (closing then re-opening the plan) never re-runs the acquisition.
  await page.getByText("Edit plan — confirmed Advanced live plan", { exact: true }).click();
  await page.getByText("Edit plan — confirmed Advanced live plan", { exact: true }).click();
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "acquire").length)).toBe(1);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "retrieve").length)).toBe(2);
  expect(await page.evaluate(() => (window as any).session.advancedRun?.id)).toBe(runId);

  // Another semantic edit invalidates the Advanced run (evidence + decisions cleared);
  // disclosure and semantic edits never re-run — only an explicit Find matches does.
  await page.locator('section[aria-label="Matching plan"] select').nth(0).selectOption("reference_context");
  s = await page.evaluate(() => (window as any).session);
  expect(s.advancedRun).toBe(undefined);
  expect(s.proposals.length).toBe(0);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "acquire").length)).toBe(1);

  // An explicit Find matches re-runs the verified acquisition.
  await page.getByRole("button", { name: "1. Find matches", exact: true }).click();
  await expect(page.locator('tr[data-testid^="matching-row-"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "acquire").length)).toBe(2);

  // Confirm the advanced proposal, then the verified atomic commit (verify + write + ack).
  await page.getByRole("button", { name: "Use this match", exact: true }).click();
  await page.getByTestId("matching-save").click();
  await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings.");
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "verify").length)).toBe(1);
  const materialized = await page.evaluate(() => (window as any).saved[0][0]);
  expect(materialized.sourceParts).toEqual(["Acme", "US"]);
  expect(materialized.outputValues).toEqual(["Acme Inc", "United States"]);

  // The acknowledged refresh re-runs the verified acquisition for the remaining review.
  await page.getByRole("button", { name: "Refresh remaining review", exact: true }).click();
  await expect(page.locator('tr[data-testid^="matching-row-"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "acquire").length)).toBe(3);
});
