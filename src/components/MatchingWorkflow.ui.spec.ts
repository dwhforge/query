import { test, expect, type Page } from "@playwright/test";
import type { JoinTupleReport } from "../lib/bridge";
import { mount } from "./MatchingWorkspace.testHarness";

// Migrated from the decommissioned Lens batch UI. These exercise CURRENT shared
// review, adapters and receipt reconciliation, not a second batch decision store.
// Real Host/atomic App/Save/reopen coverage stays in the retained Electron suites.
const rows = (page: Page) => page.locator('tr[data-testid^="matching-row-"]');
const manual = (page: Page) => page.getByRole("region", { name: "Manual right search" });
async function browse(page: Page) {
  await page.getByText("Search other records", { exact: true }).evaluate(el => { (el.parentElement as HTMLDetailsElement).open = true; });
  return manual(page);
}
async function ask(page: Page) {
  await page.getByRole("checkbox", { name: "Allow sending matching fields to external LLM" }).check();
  await page.getByTestId("matching-rank-llm").click();
  await expect.poll(() => page.evaluate("pendingLlm.length")).toBe(1);
}
async function reply(page: Page, content?: string) {
  await page.evaluate(content => {
    const w = window as any;
    w.pendingLlm.shift().resolve({ content: content ?? JSON.stringify({ pairs: w.report.sources.map((g: any) => ({
      from_parts: g.source.parts, to_parts: w.report.right_universe[0].parts, why: "reviewed evidence",
    })) }) });
  }, content);
  await expect(page.getByTestId("matching-rank-llm")).toBeEnabled();
}
function largeReport(width = 5, size = 200): JoinTupleReport {
  return {
    left_on: Array.from({ length: width }, (_, i) => `left${i}`),
    right_on: Array.from({ length: width }, (_, i) => `right${i}`),
    tuple_cap: 200, left_distinct_total: size, left_occurrences_total: size,
    right_distinct_total: size, right_occurrences_total: size, left_truncated: false, right_truncated: false,
    sources: Array.from({ length: size }, (_, g) => ({
      source: { parts: Array.from({ length: width }, (_, i) => `source${g}/${i}`), occurrences: 1 },
      candidates: Array.from({ length: size }, (_, r) => ({ right_index: r, score: .97,
        field_scores: Array(width).fill(.97) })),
    })),
    right_universe: Array.from({ length: size }, (_, r) => ({
      parts: Array.from({ length: width }, (_, i) => `target${r}/${i}`), occurrences: r === 1 ? 2 : 1,
    })),
  };
}

for (const width of [1, 2, 3, 4, 5]) {
  test(`${width}-field manual review selects without confirming, writes one exact tuple, never scalar`, async ({ page }) => {
    await mount(page, width);
    const search = await browse(page);
    await expect(search.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm selected candidate" })).toBeDisabled();
    await search.getByRole("radio").nth(1).check();
    await expect(search).toContainText("Repeated target tuple");
    expect(await page.evaluate("session.decisions.length")).toBe(0);
    await page.getByRole("button", { name: "Confirm selected candidate" }).click();
    const decision = await page.evaluate("session.decisions[0]");
    await expect(page.getByRole("region", { name: "Current draft decision" })).toContainText("target1/0");
    await page.getByRole("button", { name: /^All keys/ }).click();
    expect(await page.evaluate("session.decisions[0]")).toEqual(decision);
    await page.getByTestId("matching-save").click();
    await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1 complete tuple mappings");
    expect(await page.evaluate("saved[0][0].fromParts")).toEqual(Array.from({ length: width }, (_, i) => `source0/${i}`));
    expect(await page.evaluate("saved[0][0].outputValues")).toEqual(Array.from({ length: width }, (_, i) => `target1/${i}`));
    expect(await page.evaluate("saved.length")).toBe(1);
    expect(await page.evaluate("calls.some(c => /scalar|composite/.test(c.cmd))")).toBe(false);
  });
}

test("all-field manual search reaches below-cutoff/hidden candidates and refuses NULL output without coercion", async ({ page }) => {
  const report = largeReport(5, 25);
  report.right_universe[24]!.parts[4] = null;
  report.sources.forEach(g => g.candidates.forEach(c => { c.score = .1; }));
  await mount(page, 5, { reportOverride: report });
  await expect(page.getByRole("button", { name: "Select suggested candidate", exact: true })).toBeDisabled();
  const search = await browse(page);
  await search.getByRole("searchbox").fill("target23/4");
  await expect(search.getByRole("radio")).toHaveCount(1);
  await search.getByRole("radio").check();
  await page.getByRole("button", { name: "Confirm selected candidate" }).click();
  expect(await page.evaluate("session.decisions.length")).toBe(1);
  await page.getByRole("button", { name: "Undo decision", exact: true }).click();
  await search.getByRole("searchbox").fill("NULL");
  await search.getByRole("radio").check();
  await expect(search).toContainText("NULL cannot be represented");
  await expect(page.getByRole("button", { name: "Confirm selected candidate" })).toBeDisabled();
  expect(await page.evaluate("session.decisions.length")).toBe(0);
});

test("skip/no-suitable decisions survive presentation changes and Undo clears the temporary pick", async ({ page }) => {
  await mount(page);
  const search = await browse(page);
  await search.getByRole("radio").nth(1).check();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(search.getByRole("radio").first()).toBeDisabled();
  await page.getByRole("button", { name: /^Still open/ }).click();
  expect(await page.evaluate("session.decisions[0].kind")).toBe("defer");
  await page.getByRole("button", { name: /^All keys/ }).click();
  await rows(page).first().click();
  await page.getByRole("button", { name: "Undo decision", exact: true }).click();
  await expect(search.getByRole("radio", { checked: true })).toHaveCount(0);
  await page.getByRole("button", { name: "No match in dictionary", exact: true }).click();
  expect(await page.evaluate("session.decisions[0].kind")).toBe("no_suitable_target");
  await page.getByRole("button", { name: "Undo decision", exact: true }).click();
  expect(await page.evaluate("session.decisions")).toEqual([]);
});

test("empty RIGHT keeps unmatched sources reviewable, manual empty state and no provider call", async ({ page }) => {
  const report = largeReport(3, 2);
  report.right_universe = []; report.right_distinct_total = 0; report.right_occurrences_total = 0;
  report.sources.forEach(g => { g.candidates = []; });
  await mount(page, 3, { reportOverride: report });
  await expect(rows(page)).toHaveCount(2);
  const search = await browse(page);
  await expect(search).toContainText("No retrieved right tuples match this search.");
  await expect(page.getByRole("button", { name: "Confirm selected candidate" })).toBeDisabled();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo decision", exact: true })).toBeEnabled();
  expect(await page.evaluate("calls.filter(c => c.cmd === 'llm_chat').length")).toBe(0);
});

test("source search/sort/paging/filter preserves a visibly pinned inspector and decisions; bulk follows visible scope", async ({ page }) => {
  const report = largeReport(2, 60);
  report.sources.forEach((g, i) => { g.candidates = [{ right_index: i, score: .9 + i / 1000, field_scores: [.95, .95] }]; });
  // Complete competitors remain required: every source scores the entire universe.
  report.sources.forEach((g, i) => { g.candidates = report.right_universe.map((_, r) => ({
    right_index: r, score: r === i ? .9 + i / 1000 : .1, field_scores: r === i ? [.95, .95] : [.1, .1],
  })); });
  await mount(page, 2, { reportOverride: report });
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  const decision = await page.evaluate("session.decisions[0]");
  await page.getByRole("button", { name: "Next source page", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByText("Pinned source is outside this page/filter.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("matching-detail")).toContainText("source0/0");
  await rows(page).first().click();
  await expect(page.getByTestId("matching-detail")).toContainText("source50/0");
  await page.getByRole("searchbox", { name: "Search source keys" }).fill("source59/1");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByTestId("matching-detail")).toContainText("source50/0");
  await rows(page).first().click();
  await expect(page.getByTestId("matching-detail")).toContainText("source59/0");
  await expect(page.getByTestId("matching-bulk-confirm")).toHaveText("Accept high-confidence suggestions (1)");
  await page.getByRole("searchbox", { name: "Search source keys" }).fill("");
  await page.getByRole("combobox", { name: "Sort source keys" }).selectOption("score");
  await expect(rows(page).first()).toContainText("source59/0");
  await page.getByRole("button", { name: /^Marked to save/ }).click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(page.getByTestId("matching-detail")).toContainText("source0/0");
  expect(await page.evaluate("session.decisions[0]")).toEqual(decision);
});

test("large retrieved universe renders 8 shortlist and 20 manual rows; selection survives search/page/sort without a decision", async ({ page }) => {
  await mount(page, 5, { reportOverride: largeReport() });
  await expect(page.getByRole("region", { name: "Candidate evidence" }).getByText(/^Field scores:/)).toHaveCount(8);
  await expect(page.getByRole("region", { name: "Candidate evidence" })).toContainText("192 alternatives omitted");
  const search = await browse(page);
  await expect(search.getByRole("radio")).toHaveCount(20);
  await search.getByRole("radio").nth(1).check();
  await search.getByRole("button", { name: "Next records", exact: true }).click();
  await expect(search).toContainText("200 retrieved matches · page 2/10");
  await search.getByRole("searchbox").fill("target199/4");
  await expect(search.getByRole("radio")).toHaveCount(1);
  await expect(search).toContainText('Selected (not confirmed): "target1/0"');
  await search.getByRole("combobox").selectOption("values");
  expect(await page.evaluate("session.decisions")).toEqual([]);
  await page.getByRole("button", { name: "Confirm selected candidate" }).click();
  expect(await page.evaluate("session.candidates.find(c => c.candidateId === session.decisions[0].candidateId).outputValues[0]")).toBe("target1/0");
});

test("LLM permission gate, provider failure and retry remain interactive without affecting draft decisions", async ({ page }) => {
  await mount(page);
  await page.getByTestId("matching-rank-llm").click();
  expect(await page.evaluate("pendingLlm.length")).toBe(0);
  await expect(page.getByText("Allow sending matching fields and enter matching instructions first.")).toBeVisible();
  await ask(page);
  await page.evaluate("pendingLlm.shift().reject(new Error('provider unavailable; configure provider in Options'))");
  await expect(page.getByText(/provider unavailable; configure provider in Options/)).toBeVisible();
  await ask(page); await reply(page);
  expect(await page.evaluate("session.decisions")).toEqual([]);
});

test("fuzzy and LLM share one ledger: concurrent explicit decision survives, second source can be reviewed and written together", async ({ page }) => {
  await mount(page);
  await ask(page);
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  const first = await page.evaluate("session.decisions[0]");
  const content = await page.evaluate<string>("JSON.stringify({pairs:report.sources.map(g => ({from_parts:g.source.parts,to_parts:report.right_universe[1].parts,why:'shared complete-tuple evidence'}))})");
  await reply(page, content);
  expect(await page.evaluate("session.decisions[0]")).toEqual(first);
  await rows(page).nth(1).click();
  await expect(page.getByRole("region", { name: "Candidate evidence" })).toContainText("shared complete-tuple evidence");
  expect(await page.evaluate("session.decisions.length")).toBe(1);
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  await page.getByTestId("matching-save").click();
  await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 2");
  expect(await page.evaluate("saved[0].length")).toBe(2);
});

test("normal full-scope default stays Basic until a semantic edit; dirty plan edits require consent and never rerun", async ({ page }) => {
  await mount(page, 2, { noRun: true });
  await expect(page.getByText("Full input scope · bounded unmatched keys", { exact: true })).toBeVisible();
  expect(await page.evaluate("calls.length")).toBe(0);
  await page.getByText("Edit plan — Basic locks the original JOIN keys", { exact: true }).click();
  expect(await page.evaluate("calls.length")).toBe(0);
  await page.getByTestId("matching-apply-plan").click();
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate("session.matchingMode")).toBe("basic");
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  const decisions = await page.evaluate("session.decisions");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("combobox", { name: "How to use" }).first().selectOption("hard_constraint");
  expect(await page.evaluate("session.decisions")).toEqual(decisions);
  await expect(page.getByRole("combobox", { name: "How to use" }).first()).toHaveValue("soft_signal");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("combobox", { name: "How to use" }).first().selectOption("hard_constraint");
  expect(await page.evaluate("session.decisions")).toEqual([]);
  await expect(page.getByText(/Plan changed: previous evidence and draft decisions were cleared/)).toBeVisible();
  expect(await page.evaluate("calls.filter(c => c.cmd === 'retrieve').length")).toBe(1);
  await page.getByTestId("matching-apply-plan").click();
  await expect(page.getByTestId("matching-advanced-coverage")).toBeVisible();
  expect(await page.evaluate("calls.find(c => c.cmd === 'acquire').args.plan.scope")).toBe("full");
});

test("candidate score order puts unknown last and source switching retains separate temporary picks, never decisions", async ({ page }) => {
  const report = largeReport(2, 3);
  report.sources[0]!.candidates[0]!.score = null;
  report.sources[0]!.candidates[1]!.score = .4;
  report.sources[0]!.candidates[2]!.score = .9;
  await mount(page, 2, { reportOverride: report });
  const search = await browse(page);
  await expect(search.getByRole("radio").first().locator("..")).toContainText("target2/0");
  await expect(search.getByRole("radio").last().locator("..")).toContainText("mean unknown");
  await search.getByRole("radio").first().check();
  await rows(page).nth(1).click();
  await expect(search.getByRole("radio", { checked: true })).toHaveCount(0);
  await search.getByRole("radio").nth(1).check();
  await rows(page).first().click();
  await expect(search.getByRole("radio", { checked: true }).locator("..")).toContainText("target2/0");
  expect(await page.evaluate("session.decisions")).toEqual([]);
});

test("one LLM payload adds both sources, bounded prompts omit secrets/history and focusing distant sources reaches them", async ({ page }) => {
  await mount(page, 5, { reportOverride: largeReport() });
  for (let i = 0; i < 4; i++) { await ask(page); await reply(page); }
  const requests = await page.evaluate<{ messages: { content: string }[] }[]>("calls.filter(c => c.cmd === 'llm_chat').map(c => c.args)");
  expect(requests).toHaveLength(4);
  for (const { messages } of requests) {
    expect(messages).toHaveLength(2); // Current Matching has instructions, not the removed Lens chat store.
    expect(messages[0]!.content.length).toBeLessThanOrEqual(10_000);
    expect(messages[1]!.content.length).toBeLessThanOrEqual(4_000);
    expect(messages[0]!.content).not.toContain("target199/");
    expect(messages[0]!.content).not.toContain("contextFingerprint");
  }
  await page.getByRole("searchbox", { name: "Search source keys" }).fill("source190/0");
  await rows(page).first().click();
  await ask(page);
  expect(await page.evaluate<string>("calls.filter(c => c.cmd === 'llm_chat').at(-1).args.messages[0].content")).toContain("source190/0");
  await reply(page);
  expect(await page.evaluate("session.decisions")).toEqual([]);
});

for (const invalid of ["multiple-payloads", "oversized", "invented"] as const) {
  test(`LLM ${invalid} response is rejected whole, never imported from a valid prefix`, async ({ page }) => {
    await mount(page); await ask(page);
    const payload = await page.evaluate<string>("JSON.stringify({pairs:[{from_parts:report.sources[0].source.parts,to_parts:report.right_universe[0].parts,why:'must not import'}]})");
    await reply(page, invalid === "multiple-payloads" ? payload + "\n" + payload
      : invalid === "oversized" ? payload + " ".repeat(12_000) + payload
        : JSON.stringify({ pairs: [{ from_parts: ["invented"], to_parts: ["invented"] }] }));
    await expect(page.getByText(invalid === "oversized" ? /Oversized model response/ : /No valid complete tuple pairs/)).toBeVisible();
    expect(await page.evaluate("session.proposals.some(p => p.edges.some(e => e.origins.includes('llm')))")).toBe(false);
    expect(await page.evaluate("session.decisions")).toEqual([]);
  });
}

for (const kind of ["workspace", "connections", "sources", "projectRef"] as const) {
  test(`late retrieval cannot install evidence after ${kind} definition invalidation`, async ({ page }) => {
    await mount(page, 2, { holdRetrieve: true });
    await page.evaluate(kind => (window as any).changeContext("p:0", `changed:${kind}`), kind);
    await page.evaluate("releaseRetrieve()");
    await expect(page.getByText(/Original JOIN context changed/)).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    expect(await page.evaluate("saved.length")).toBe(0);
  });
}

for (const kind of ["context", "unmount"] as const) {
  test(`late LLM reply after ${kind} cannot add evidence or publish`, async ({ page }) => {
    await mount(page); await ask(page);
    await page.evaluate(kind => kind === "unmount" ? (window as any).unmount() : (window as any).changeContext(), kind);
    await page.evaluate(() => {
      const w = window as any;
      w.pendingLlm.shift().resolve({ content: JSON.stringify({ pairs: [{ from_parts: w.report.sources[0].source.parts,
        to_parts: w.report.right_universe[1].parts, why: "stale evidence" }] }) });
    });
    await page.waitForTimeout(50);
    expect(await page.evaluate("session.proposals.some(p => p.edges.some(e => e.origins.includes('llm')))")).toBe(false);
    expect(await page.evaluate("saved.length")).toBe(0);
  });
}

test("owned receipt before callback keeps review locked, shifts JOIN index, clears decisions and waits for explicit refresh", async ({ page }) => {
  await mount(page, 2, { holdWrite: true });
  await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
  await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
  await page.getByTestId("matching-save").click();
  await page.evaluate("changeContext('p:0','next',expectedReceipt)");
  await expect(page.getByTestId("matching-workspace")).toHaveAttribute("inert", "");
  expect(await page.evaluate("calls.filter(c => c.cmd === 'retrieve').length")).toBe(1);
  await page.evaluate("releaseWrite(); holdWrite=false");
  await expect(page.getByRole("region", { name: "Matching commit receipt" })).toContainText("Applied 1");
  expect(await page.evaluate("session.joinBinding.joinStepIndex")).toBe(2);
  expect(await page.evaluate("session.decisions")).toEqual([]);
  expect(await page.evaluate("calls.filter(c => c.cmd === 'retrieve').length")).toBe(1);
  await page.getByRole("button", { name: "Refresh remaining review", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate("calls.filter(c => c.cmd === 'retrieve').length")).toBe(2);
});

for (const kind of ["edit-before", "project-aba", "context-aba", "edit-after", "rejected-after-context"] as const) {
  test(`commit cannot restore stale decisions/receipt after ${kind}`, async ({ page }) => {
    await mount(page, 2, { holdWrite: true });
    await page.getByRole("button", { name: "Select suggested candidate", exact: true }).click();
    await page.getByRole("button", { name: "Confirm selected candidate", exact: true }).click();
    await page.getByTestId("matching-save").click();
    if (kind === "edit-after") {
      await page.evaluate("releaseWrite(); holdWrite=false");
      await expect(page.getByRole("region", { name: "Matching commit receipt" })).toBeVisible();
      await page.evaluate("changeContext('p:0','edited-after')");
    } else {
      await page.evaluate(kind => {
        const w = window as any;
        if (kind === "rejected-after-context") w.failWrite = true;
        w.changeContext(kind === "project-aba" ? "other:1" : "p:0", "edited-before");
      }, kind);
      await expect(page.getByText(/Original JOIN context changed/)).toBeVisible();
      if (kind === "project-aba" || kind === "context-aba") await page.evaluate("changeContext('p:0','local')");
      await page.evaluate("releaseWrite(); holdWrite=false");
    }
    await expect(page.getByRole("region", { name: "Matching commit receipt" })).toHaveCount(0);
    expect(await page.evaluate("session.commitLifecycle.status")).toBe("stale");
    if (kind !== "edit-after") await expect(page.getByTestId("matching-save")).toBeDisabled();
    if (kind !== "edit-after") await expect(page.getByRole("button", { name: "Select suggested candidate", exact: true })).toBeDisabled();
    expect(await page.evaluate("calls.filter(c => c.cmd === 'retrieve').length")).toBe(1);
  });
}

for (const scope of ["selected", "cohort"] as const) {
  test(`Advanced ${scope} scope explicitly refuses instead of silently acquiring full input`, async ({ page }) => {
    await mount(page, 2, { scope, noRun: true });
    await page.getByText("Edit plan — Basic locks the original JOIN keys", { exact: true }).click();
    await page.getByRole("combobox", { name: "How to use" }).first().selectOption("hard_constraint");
    await page.getByTestId("matching-apply-plan").click();
    await expect(page.getByText(/Advanced selected\/cohort scope is unsupported/)).toBeVisible();
    expect(await page.evaluate("calls.filter(c => c.cmd === 'acquire').length")).toBe(0);
    expect(await page.evaluate("session.scope")).toBe(scope);
    await expect(rows(page)).toHaveCount(0);
  });
}
