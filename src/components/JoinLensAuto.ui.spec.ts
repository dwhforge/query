import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import type { JoinTupleReport } from "../lib/bridge";

const harness = buildSync({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import { createElement, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { JoinLensAuto } from "./src/components/JoinLensAuto";
    window.calls = []; window.accepted = []; window.pendingLlm = []; window.pendingSuggest = [];
    window.pendingCommit = []; window.scalarCalls = [];
    window.dwh = { invoke: async (cmd, args) => {
      window.calls.push({cmd, args});
      if (cmd === "get_llm_config") return window.noProvider
        ? {base_url: "", model: "", api_key_set: false}
        : {base_url: "http://local", model: "test", api_key_set: true};
      if (cmd === "set_llm_config") return {base_url: args.baseUrl, model: args.model, api_key_set: !args.clearApiKey};
      if (cmd === "join_key_fuzzy_suggest") {
        const report = {tuple_report: structuredClone(window.fixture), score_cutoff: .85};
        if (window.holdSuggest) return new Promise(resolve => window.pendingSuggest.push(() => resolve(report)));
        return report;
      }
      if (cmd === "llm_chat") return new Promise((resolve, reject) => window.pendingLlm.push({resolve, reject}));
      throw new Error(cmd);
    }};
    function App() {
      const [props, setProps] = useState({workspace: {focus_query_id: "fact", queries: []},
        hostQueryId: "fact", joinStepIndex: 1, connections: [{id: "local", password: "secret-connection"}],
        sources: [], projectRef: {projectUid: "project-a"}});
      window.patch = patch => setProps(p => ({...p, ...patch}));
      return createElement(JoinLensAuto, {...props,
        onAccept: (...args) => window.scalarCalls.push(args),
        onAcceptTuples: async (selections, fingerprint) => {
          window.accepted.push({selections, fingerprint});
          if (window.holdCommit) return new Promise(resolve => window.pendingCommit.push(resolve));
          return window.commitError || null;
        },
      });
    }
    const root = createRoot(document.getElementById("root"));
    window.unmount = () => root.unmount();
    root.render(createElement(App));
  ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "import.meta.env.DWH_E2E": '"0"', "process.env.NODE_ENV": '"test"' },
}).outputFiles[0]!.text;

function fixture(n: number): JoinTupleReport {
  return {
    left_on: Array.from({ length: n }, (_, i) => `left_${i}`), right_on: Array.from({ length: n }, (_, i) => `right_${i}`),
    sources: [0, 1].map(g => ({ source: { parts: Array.from({ length: n }, (_, i) => `source ${g}/${i}`), occurrences: 3 },
      candidates: [0, 1, 2].map(right_index => ({ right_index, score: g === 0 && right_index < 2 ? .97 : .1,
        field_scores: Array(n).fill(g === 0 && right_index < 2 ? .97 : .1) })) })),
    right_universe: [0, 1, 2].map(g => ({ parts: Array.from({ length: n }, (_, i) => `target ${g}/${i}`), occurrences: g + 1 })),
    left_distinct_total: 300, left_occurrences_total: 1000, right_distinct_total: 500,
    right_occurrences_total: 2000, left_truncated: true, right_truncated: true, tuple_cap: 200,
  };
}
async function mount(page: Page, n = 2, options: { holdSuggest?: boolean; noProvider?: boolean; holdCommit?: boolean } = {}, report = fixture(n)) {
  await page.route("**/__batch-test.html", route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="height:900px;display:flex;flex-direction:column"></div>' }));
  await page.goto("/__batch-test.html");
  await page.addStyleTag({ url: "/src/index.css?direct" });
  await page.evaluate(({ report, options }) => Object.assign(window, { fixture: report, ...options }), { report, options });
  await page.addScriptTag({ content: harness });
  await expect(page.getByRole("button", { name: "Open LLM chat" })).toBeVisible();
  if (!options.holdSuggest) await expect(page.getByText("Complete source tuple", { exact: true })).toBeVisible();
}
const alternatives = (page: Page) => page.getByRole("region", { name: "Proposed alternatives" });
async function resolveLlm(page: Page, pairs: unknown[]) {
  await page.evaluate(pairs => (window as any).pendingLlm.shift().resolve({ content: "Evidence from aligned fields.\n```json\n" + JSON.stringify({ pairs }) + "\n```" }), pairs);
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates" })).not.toHaveText("Ranking…");
}

for (const n of [1, 2, 3, 4, 5]) {
  test(`${n}-field review writes full tuple once, no scalar modes`, async ({ page }) => {
    await mount(page, n, { holdCommit: true });
    expect(await page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').length")).toBe(1);
    const args = await page.evaluate<Record<string, unknown>>("calls.find(c => c.cmd === 'join_key_fuzzy_suggest').args");
    expect(args.tuple).toEqual({});
    expect(args.keyIndex).toBeUndefined(); expect(args.compositeIndices).toBeUndefined();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByText(/Ambiguous:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept selected" })).toBeDisabled();
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
    await alternatives(page).getByRole("radio").nth(1).check();
    await expect(alternatives(page).getByText("Duplicate target: Join may multiply rows", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Accept selected" }).click();
    await page.getByRole("button", { name: "Write Mapping (1)" }).click();
    await expect(page.getByRole("button", { name: "Applying…" })).toBeDisabled();
    await page.evaluate("pendingCommit.shift()(null)");
    await expect(page.getByRole("button", { name: "Applied", exact: true })).toBeDisabled();
    const accepted = await page.evaluate<{ selections: { fromParts: string[]; outputValues: string[]; leftOn: string[]; rightOn: string[] }[]; fingerprint: string }>("accepted[0]");
    expect(accepted.selections[0].fromParts).toEqual(fixture(n).sources[0]!.source.parts);
    expect(accepted.selections[0].outputValues).toEqual(fixture(n).right_universe[1]!.parts);
    expect(accepted.selections[0].leftOn).toHaveLength(n);
    expect(accepted.selections[0].rightOn).toHaveLength(n);
    expect(accepted.fingerprint).toContain("project-a");
    expect(await page.evaluate("scalarCalls.length")).toBe(0);
    expect(await page.evaluate("accepted.length")).toBe(1);
  });
}

test("shared fuzzy/LLM queue preserves concurrent decisions and commits together", async ({ page }) => {
  const report = fixture(3);
  await mount(page, 3);
  await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
  await alternatives(page).getByRole("radio").first().check();
  await page.getByRole("button", { name: "Accept selected" }).click();
  await resolveLlm(page, [
    { from_parts: report.sources[0]!.source.parts, to_parts: report.right_universe[2]!.parts, why: "conflict ignored" },
    { from_parts: report.sources[0]!.source.parts, to_parts: report.right_universe[0]!.parts, why: "duplicate ignored" },
    { from_parts: report.sources[1]!.source.parts, to_parts: report.right_universe[2]!.parts, why: "contextual alias" },
    { from_parts: report.sources[1]!.source.parts, to_parts: ["invented", "x", "y"], why: "reject" },
  ]);
  await expect(page.getByText(/1 conflicts ignored/)).toBeVisible();
  await page.getByRole("navigation", { name: "Tuple review queue" }).getByRole("button").nth(1).click();
  await expect(alternatives(page).getByText("contextual alias")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept selected" })).toBeDisabled();
  await alternatives(page).getByRole("radio").check();
  await page.getByRole("button", { name: "Accept selected" }).click();
  await page.getByRole("button", { name: "Write Mapping (2)" }).click();
  expect(await page.evaluate("accepted[0].selections.length")).toBe(2);
  const messages = await page.evaluate<{ content: string }[]>("calls.find(c => c.cmd === 'llm_chat').args.messages");
  expect(JSON.stringify(messages)).not.toContain("secret-connection");
  expect(messages[0].content.length).toBeLessThanOrEqual(10_000);
});

test("skip, undo, all-field manual search and NULL safety", async ({ page }) => {
  const report = fixture(5);
  report.right_universe.push({ parts: ["nullable", "x", "y", "z", null], occurrences: 1 });
  await mount(page, 5, {}, report);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(alternatives(page).getByRole("radio").first()).toBeDisabled();
  await page.getByRole("button", { name: "Undo decision" }).click();
  await page.getByText(/Search other records/).click();
  const manual = page.getByRole("region", { name: "Manual right search" });
  await page.getByRole("searchbox").fill("target 2/4");
  await expect(manual.getByRole("radio")).toHaveCount(1);
  await manual.getByRole("radio").check();
  await expect(page.getByRole("button", { name: "Accept selected" })).toBeEnabled();
  await page.getByRole("searchbox").fill("NULL");
  await manual.getByRole("radio").check();
  await expect(page.getByRole("button", { name: "Accept selected" })).toBeDisabled();
  await expect(manual.getByText(/NULL cannot be represented/)).toBeVisible();
});

test("no candidates retains source and provider settings/chat errors remain interactive", async ({ page }) => {
  const report = fixture(2);
  report.sources.forEach(s => s.candidates.forEach(c => { c.score = .1; }));
  await mount(page, 2, { noProvider: true }, report);
  await expect(page.getByText(/No fuzzy candidates/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates" })).toBeDisabled();
  await page.getByRole("button", { name: "Open LLM chat" }).click();
  await page.getByLabel("base_url", { exact: true }).fill("http://local");
  await page.getByLabel("model", { exact: true }).fill("demo");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates" })).toBeEnabled();
  await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
  await page.evaluate("pendingLlm.shift().reject(new Error('provider unavailable'))");
  await expect(page.getByRole("alert")).toContainText("provider unavailable");
  await page.getByRole("textbox", { name: "Chat message" }).fill("Review the region too");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await resolveLlm(page, []);
  await expect(page.getByRole("alert")).toContainText("No valid complete tuple pairs");
});

for (const patch of [
  { workspace: { focus_query_id: "fact", queries: [{ id: "upstream", steps: [] }] } },
  { connections: [{ id: "local", password: "changed" }] },
  { sources: [{ id: "source", path: "changed.csv" }] },
  { projectRef: { projectUid: "different-project" } },
]) {
  test(`stale retrieval invalidated by ${Object.keys(patch)[0]}`, async ({ page }) => {
    await mount(page, 2, { holdSuggest: true });
    await page.evaluate(patch => (window as any).patch(patch), patch);
    await expect.poll(() => page.evaluate("pendingSuggest.length")).toBe(2);
    await page.evaluate("pendingSuggest.shift()()");
    await expect(page.getByText("Complete source tuple", { exact: true })).toHaveCount(0);
    await page.evaluate("pendingSuggest.shift()()");
    await expect(page.getByText("Complete source tuple", { exact: true })).toBeVisible();
  });
}

test("late LLM reply is ignored after context change and unmount", async ({ page }) => {
  const report = fixture(2);
  await mount(page);
  await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
  await page.evaluate("patch({projectRef: {projectUid: 'new'}})");
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates" })).toBeEnabled();
  await resolveLlm(page, [{ from_parts: report.sources[1]!.source.parts, to_parts: report.right_universe[2]!.parts, why: "stale" }]);
  await expect(page.getByText("stale", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button").nth(1).click();
  await expect(alternatives(page).getByRole("radio")).toHaveCount(0);
  await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
  await page.evaluate("unmount(); pendingLlm.shift().resolve({content: 'late'})");
  expect(await page.evaluate("accepted.length")).toBe(0);
});

test("commit failure keeps reviewed data for correction or retry", async ({ page }) => {
  await mount(page);
  await alternatives(page).getByRole("radio").first().check();
  await page.getByRole("button", { name: "Accept selected" }).click();
  await page.evaluate("window.commitError = 'Mapping has unsaved edits'");
  await page.getByRole("button", { name: "Write Mapping (1)" }).click();
  await expect(page.getByRole("alert")).toHaveText("Mapping has unsaved edits");
  await expect(page.getByRole("button", { name: "Write Mapping (1)" })).toBeEnabled();
  await page.getByRole("button", { name: "Undo decision" }).click();
  await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
});

test("empty right universe keeps unmatched sources reviewable without LLM calls", async ({ page }) => {
  const report = fixture(3);
  report.right_universe = [];
  report.right_distinct_total = 0;
  report.right_occurrences_total = 0;
  report.sources.forEach(s => { s.candidates = []; });
  await mount(page, 3, {}, report);
  await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(2);
  await expect(page.getByText(/No fuzzy candidates/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates" })).toBeDisabled();
  await page.getByText(/Search other records/).click();
  await expect(page.getByText("No retrieved right tuples match this search.")).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo decision" })).toBeEnabled();
  expect(await page.evaluate("calls.filter(c => c.cmd === 'llm_chat').length")).toBe(0);
});

test("large tuple reports keep prompts, history, fuzzy shortlists and rendered manual results bounded", async ({ page }) => {
  const report = fixture(5);
  report.right_universe = Array.from({ length: 200 }, (_, g) => ({ parts: Array.from({ length: 5 }, (_, i) => `target ${g}/${i}`), occurrences: 1 }));
  report.sources = Array.from({ length: 200 }, (_, g) => ({ source: { parts: Array.from({ length: 5 }, (_, i) => `source ${g}/${i}`), occurrences: 1 },
    candidates: Array.from({ length: 200 }, (_, right_index) => ({ right_index, score: .97, field_scores: Array(5).fill(.97) })) }));
  await mount(page, 5, {}, report);
  await expect(alternatives(page).getByRole("radio")).toHaveCount(8);
  await expect(page.getByText(/192 additional fuzzy alternatives omitted/)).toBeVisible();
  await expect(page.getByText(/Incomplete retrieval coverage/)).toBeVisible();
  await page.getByText(/Search other records/).click();
  const manual = page.getByRole("region", { name: "Manual right search" });
  await expect(manual.getByRole("radio")).toHaveCount(20);
  await page.getByRole("button", { name: "Next records" }).click();
  await expect(manual.getByText("200 retrieved matches · page 2/10")).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
    await resolveLlm(page, []);
  }
  const requests = await page.evaluate<{ messages: { role: string; content: string }[] }[]>("calls.filter(c => c.cmd === 'llm_chat').map(c => c.args)");
  expect(requests).toHaveLength(4);
  for (const request of requests) {
    expect(request.messages.length).toBeLessThanOrEqual(7);
    expect(request.messages[0]!.content.length).toBeLessThanOrEqual(10_000);
    expect(request.messages.slice(1).every(m => m.content.length <= 4_000)).toBe(true);
    expect(request.messages[0]!.content).not.toContain('target 199/');
    expect(request.messages[0]!.content).toContain('Incomplete coverage:');
  }
  expect(requests[3]!.messages.length).toBe(7);
  await page.getByRole("navigation").getByRole("button").nth(190).click();
  await page.getByRole("button", { name: "Ask LLM to rank candidates" }).click();
  expect(await page.evaluate<string>("calls.filter(c => c.cmd === 'llm_chat').at(-1).args.messages[0].content")).toContain("source 190/0");
  await resolveLlm(page, []);
});
