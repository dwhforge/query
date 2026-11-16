import { test, expect } from "@playwright/test";
import { mount } from "./MatchingWorkspace.testHarness";

test("one click selects a RIGHT candidate without deciding, then Confirm stages it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, 2);
  const right = page.getByRole("region", { name: "RIGHT relationship explorer" });
  const select = right.getByTestId("matching-select-target").first();
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  const confirm = page.getByRole("button", { name: "Confirm selected candidate", exact: true });
  await expect(confirm).toBeEnabled();
  const inspector = page.getByTestId("matching-detail");
  const [box, action] = await Promise.all([inspector.boundingBox(), confirm.boundingBox()]);
  expect(box && action).toBeTruthy();
  expect(action!.y).toBeGreaterThanOrEqual(box!.y);
  expect(action!.y + action!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
  await confirm.click();
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(1);
});

test("keyboard pick and explicit confirmation are separate; sequential review preserves picks and filters", async ({ page }) => {
  await mount(page, 2);
  const detail = page.getByTestId("matching-detail");
  await detail.getByRole("button", { name: "Select suggested candidate" }).click();
  expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  await page.getByRole("button", { name: "Next unresolved", exact: true }).click();
  await page.getByRole("button", { name: "Previous unresolved", exact: true }).click();
  await expect(detail).toContainText("Selected for confirmation");
  expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  await page.getByRole("checkbox", { name: "Advance after confirm", exact: true }).check();
  const confirm = detail.getByRole("button", { name: "Confirm selected candidate", exact: true });
  await confirm.focus(); await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(1);
  await expect(detail).toContainText("source1/0");
  expect(await page.evaluate(() => (window as any).session.reviewFilter)).toBe("all");
});

test("RIGHT browsing never selects or confirms and uses one provenance-filtered related LEFT list", async ({ page }) => {
  await mount(page, 2);
  const browser = page.getByRole("region", { name: "RIGHT relationship explorer" });
  await browser.getByTestId("matching-browse-target").first().click();
  const related = page.getByRole("region", { name: "LEFT records related to selected RIGHT" });
  await expect(related.getByRole("list", { name: "Unified related LEFT records" })).toHaveCount(1);
  await expect(page.getByTestId("matching-detail").getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm selected candidate", exact: true })).toBeDisabled();
  await expect(browser).toContainText("Actual JOIN: not inspected");
  await related.getByRole("combobox", { name: "Relationship provenance" }).selectOption("Confirmed draft");
  await expect(related.getByRole("listitem")).toHaveCount(0);
  await related.getByRole("combobox", { name: "Relationship provenance" }).selectOption("Suggested");
  await related.getByRole("listitem").last().getByRole("button", { name: /Investigate this source/ }).click();
  await expect(page.getByTestId("matching-detail")).toContainText("source1/0");
  await page.getByRole("button", { name: "Select this relationship for inspection", exact: true }).click();
  expect(await page.evaluate(() => (window as any).session.decisions)).toEqual([]);
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  await expect(related.getByRole("listitem").last()).toContainText("Confirmed draft");
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === "retrieve").length)).toBe(1);
});

test("the two primary explorers are siblings above a compact relationship inspector", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, 2);
  const left = page.getByRole("region", { name: "Source explorer" });
  const right = page.getByRole("region", { name: "RIGHT relationship explorer" });
  expect(await page.evaluate(() => {
    const leftEl = document.querySelector('[aria-label="Source explorer"]');
    const rightEl = document.querySelector('[aria-label="RIGHT relationship explorer"]');
    return !!leftEl && !!rightEl && leftEl.parentElement === rightEl.parentElement;
  })).toBe(true);
  const [l, r, inspector, footer] = await Promise.all([
    left.boundingBox(), right.boundingBox(), page.getByRole("region", { name: "Relationship comparison" }).boundingBox(), page.getByTestId("matching-save").boundingBox(),
  ]);
  expect(l && r && inspector && footer).toBeTruthy();
  expect(l!.x).toBeLessThan(r!.x);
  expect(inspector!.y).toBeGreaterThan(Math.max(l!.y + l!.height, r!.y + r!.height) - 3);
  await expect(left).toContainText("source0/0");
  await expect(right).toContainText("target0/0");
  await expect(page.getByTestId("matching-detail").getByRole("button", { name: "Confirm selected candidate" })).toBeVisible();
  await expect(page.getByTestId("matching-save")).toBeVisible();
});

test("RIGHT Explorer and manual candidate search find independent target identity-only values", async ({ page }) => {
  await mount(page, 2);
  await page.evaluate(() => {
    const s = (window as any).session;
    s.candidates = s.candidates.map((c: any, i: number) => ({ ...c, identityParts: [`independent-id-${i}`], fields: {} }));
    (window as any).patchSession({ candidates: s.candidates });
  });
  const right = page.getByRole("region", { name: "RIGHT relationship explorer" });
  await right.getByRole("searchbox", { name: "Search acquired targets" }).fill("independent-id-1");
  await expect(right.getByTestId("matching-browse-target")).toHaveCount(1);
  await right.getByRole("searchbox", { name: "Search acquired targets" }).fill("");
  await page.getByText("Search other records", { exact: true }).evaluate(el => { (el.parentElement as HTMLDetailsElement).open = true; });
  const manual = page.getByRole("region", { name: "Manual right search" });
  await manual.getByRole("searchbox", { name: "Search right candidates" }).fill("independent-id-1");
  await expect(manual.getByRole("radio")).toHaveCount(1);
});

test("compatible baseline shows no-op, conflict and saved-only aliases with merged non-additive provenance", async ({ page }) => {
  await mount(page, 2, { baseline: { complete: true, coverage: "Complete within project definition", rows: [
    { fromParts: ["source0/0", "source0/1"], outputValues: ["target0/0", "target0/1"] },
    { fromParts: ["source1/0", "source1/1"], outputValues: ["other", "outputs"] },
    { fromParts: ["saved alias", "DE"], outputValues: ["target0/0", "target0/1"] },
  ] } });
  await page.getByText(/Details ·/).click();
  await expect(page.getByRole("region", { name: "Relationship comparison" })).toContainText("Already matches / no-op");
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  const browser = page.getByRole("region", { name: "RIGHT relationship explorer" });
  await browser.getByTestId("matching-browse-target").first().click();
  const related = page.getByRole("region", { name: "LEFT records related to selected RIGHT" });
  const same = related.getByRole("listitem").filter({ hasText: "source0/0" });
  await expect(same).toContainText("Suggested");
  await expect(same).toContainText("Confirmed draft");
  await expect(same).toContainText("Existing Mapping");
  const saved = related.getByRole("listitem").filter({ hasText: "saved alias" });
  await expect(saved).toContainText("outside this run — read-only");
  await expect(saved.getByRole("button")).toHaveCount(0);
  await browser.getByText(/Evidence & Coverage/).click();
  await expect(browser.getByRole("region", { name: "Relationship authority coverage" })).toContainText("counts are non-additive");
  await page.getByRole("button", { name: "Return to LEFT review", exact: true }).click();
  await page.locator('tr[data-testid^="matching-row-"]').last().click();
  await expect(page.getByRole("region", { name: "Relationship comparison" })).toContainText("Conflict: existing outputs differ");
  expect(await page.evaluate(() => (window as any).session.decisions.length)).toBe(1);
});

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
  await expect(page.locator("button").filter({ hasText: "Select suggested candidate" })).toBeDisabled();
  await expect(page.getByTestId("matching-bulk-confirm")).toBeDisabled();
});

test("failed write retains decisions and permits retry; pending locks old rows", async ({ page }) => {
  await mount(page, 3, { failWrite: true, holdWrite: true });
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  await page.getByTestId("matching-save").click();
  await expect(page.getByTestId("matching-workspace")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Select suggested candidate", exact: true })).toBeDisabled();
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
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
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
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
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
  await page.getByText(/Evidence & coverage · verified live acquisition/).click();
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
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
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
