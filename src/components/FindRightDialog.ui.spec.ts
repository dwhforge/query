import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import type { JoinKeyFuzzySuggest } from "../lib/bridge";

// Standalone browser component tests. No Rust host or Electron process required.
const harness = buildSync({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import { createElement, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { FindRightDialog } from "./src/components/FindRightDialog";
    window.calls = []; window.accepted = []; window.pendingLlm = []; window.pendingSuggest = [];
    window.dwh = { invoke: async (cmd, args) => {
      window.calls.push({cmd, args});
      if (cmd === "get_llm_config") return window.noProvider ? {} : {base_url: "http://local", model: "test", api_key_set: false};
      if (cmd === "join_key_fuzzy_suggest") {
        const report = structuredClone(window.fixture);
        report.tuple_report.sources[0].source.parts = args.tuple.source_parts;
        if (window.holdSuggest) return new Promise(resolve => window.pendingSuggest.push(() => resolve(report)));
        return report;
      }
      if (cmd === "llm_chat") return new Promise(resolve => window.pendingLlm.push(resolve));
      throw new Error(cmd);
    }};
    function App() {
      const [props, setProps] = useState({
        open: true, fromParts: window.source, workspace: {focus_query_id: "fact", queries: []},
        hostQueryId: "fact", joinStepIndex: 1, connections: [], projectRef: {projectUid: "project-a"},
      });
      window.patch = patch => setProps(p => ({...p, ...patch}));
      return createElement(FindRightDialog, {...props,
        onClose: () => setProps(p => ({...p, open: false})),
        onAccept: mapping => window.accepted.push(mapping),
      });
    }
    createRoot(document.getElementById("root")).render(createElement(App));
  ` },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "import.meta.env.DWH_E2E": '"0"', "process.env.NODE_ENV": '"test"' },
}).outputFiles[0]!.text;

function fixture(n: number, fuzzy = true): JoinKeyFuzzySuggest {
  const left = Array.from({ length: n }, (_, i) => `left_${i}`);
  const right = Array.from({ length: n }, (_, i) => `right_${i}`);
  return {
    host_query_id: "fact", join_step_index: 1, left_on: left, right_on: right,
    metric: "jaro", score_cutoff: 0.85, suggestions: [], leftover_left: [], leftover_right: [],
    scanned_left: 0, scanned_right: 0, unmatched_left_total: 0, unmatched_right_total: 0, truncated: false,
    chat_context: { left_query_id: "", left_query_name: "", right_query_id: "", right_query_name: "",
      left_lineage: "", right_lineage: "", left_columns: [], right_columns: [], leftover_left_samples: [],
      leftover_right_samples: [], existing_aliases: [] },
    tuple_report: {
      left_on: left, right_on: right,
      sources: [{ source: { parts: left.map((_, i) => `source ${i}`), occurrences: 3 },
        candidates: [0, 1, 2].map((right_index) => ({ right_index,
          score: fuzzy && right_index === 0 ? 0.96 : 0.1,
          field_scores: left.map(() => fuzzy && right_index === 0 ? 0.96 : 0.1) })) }],
      right_universe: [
        { parts: right.map((_, i) => `target ${i}`), occurrences: 4 },
        { parts: right.map((_, i) => i === n - 1 ? "search-only" : "manual"), occurrences: 2 },
        { parts: right.map((_, i) => i === n - 1 ? null : "nullable"), occurrences: 1 },
      ],
      left_distinct_total: 1, left_occurrences_total: 3,
      right_distinct_total: 3, right_occurrences_total: 7,
      left_truncated: false, right_truncated: true, tuple_cap: 1200,
    },
  };
}

async function mount(page: Page, n: number, fuzzy = true, source?: (string | null)[], options: { holdSuggest?: boolean; noProvider?: boolean } = {}) {
  const report = fixture(n, fuzzy);
  await page.route("**/__component-test.html", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("/__component-test.html");
  await page.addStyleTag({ url: "/src/index.css?direct" });
  await page.evaluate(({ report, source, options }) => {
    Object.assign(window, { fixture: report, source, ...options });
  }, { report, source: source ?? report.tuple_report!.sources[0]!.source.parts, options });
  await page.addScriptTag({ content: harness });
  await expect(page.getByRole("dialog")).toBeVisible();
  if (!options.holdSuggest) await expect(page.getByText("Search other records")).toBeVisible();
}

for (const n of [1, 2, 3]) {
  test(`one automatic full-tuple request and explicit ${n}-field selection`, async ({ page }) => {
    await mount(page, n);
    expect(await page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').length")).toBe(1);
    expect(await page.evaluate("calls.find(c => c.cmd === 'join_key_fuzzy_suggest').args.tuple.source_parts.length")).toBe(n);
    expect(await page.evaluate("Object.keys(calls.find(c => c.cmd === 'join_key_fuzzy_suggest').args)")).not.toContain("keyIndex");
    expect(await page.evaluate("calls.filter(c => c.cmd === 'llm_chat').length")).toBe(0);
    await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(page.getByText(/Bounded results/)).toBeVisible();
    await expect(page.getByText("4 rows · 3 duplicate rows · 0 NULL fields").first()).toBeVisible();
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: "Add to mapping" }).click();
    expect(await page.evaluate("accepted[0].fromParts")).toEqual(Array.from({ length: n }, (_, i) => `source ${i}`));
    expect(await page.evaluate("accepted[0].outputValues")).toEqual(Array.from({ length: n }, (_, i) => `target ${i}`));
  });
}

test("manual search spans all fields and NULL target is visible but blocked", async ({ page }, info) => {
  await mount(page, 3);
  await page.getByText("Search other records").click();
  const manual = page.getByRole("region", { name: "Manual right search" });
  await expect(manual.locator("table")).toHaveCount(0);
  await expect(manual.getByText("right_2", { exact: false }).first()).toBeVisible();
  await expect(manual.getByText("Field scores:", { exact: false }).first()).toBeVisible();
  await page.getByRole("searchbox").fill("NULL");
  await page.getByRole("radio", { name: /nullable/ }).check();
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
  await expect(page.getByText(/NULL cannot be represented/).first()).toBeVisible();
  await page.getByRole("searchbox").fill("search-only");
  await page.getByRole("radio", { name: /search-only/ }).check();
  await page.screenshot({ path: info.outputPath("suggest-right-compact-manual.png") });
  await page.getByRole("button", { name: "Add to mapping" }).click();
  expect(await page.evaluate("accepted[0].outputValues")).toEqual(["manual", "manual", "search-only"]);
  expect(await page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').length")).toBe(1);
});

test("Ask LLM works alongside fuzzy results and rejects invented/partial tuples", async ({ page }) => {
  await mount(page, 2);
  await page.getByRole("button", { name: "Ask LLM to rank candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pendingLlm.length")).toBe(1);
  const pairs = [
    { from_parts: ["source 0", "source 1"], to_parts: ["invented", "search-only"], why: "bad" },
    { from_parts: ["source 0", "source 1"], to_parts: ["target 0"], why: "partial" },
    { from_parts: ["source 0", "source 1"], to_parts: ["manual", "search-only"], why: "domain evidence" },
  ];
  await page.evaluate((content) => {
    (window as unknown as { pendingLlm: ((x: unknown) => void)[] }).pendingLlm.shift()!({ content });
  }, JSON.stringify({ pairs }));
  await expect(page.getByText("domain evidence", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /invented/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
  const suggestions = page.getByRole("region", { name: "Suggestions", exact: true });
  await suggestions.getByRole("radio", { name: /search-only/ }).check();
  await page.getByRole("button", { name: "Add to mapping" }).click();
  expect(await page.evaluate("accepted[0].outputValues")).toEqual(["manual", "search-only"]);
});

test("late manual LLM reply cannot populate a different project context", async ({ page }) => {
  await mount(page, 2);
  await page.getByRole("button", { name: "Ask LLM to rank candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pendingLlm.length")).toBe(1);
  await page.evaluate("patch({projectRef: {projectUid: 'project-b'}})");
  await expect.poll(() => page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').length")).toBe(2);
  await page.evaluate(`pendingLlm.shift()({content: 'STALE RESPONSE ' + JSON.stringify({pairs:[{from_parts:['source 0','source 1'],to_parts:['manual','search-only'],why:'stale evidence'}]})})`);
  await expect(page.getByText("stale evidence", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/STALE RESPONSE/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Ask LLM to rank candidates", exact: true })).toBeEnabled();
});

test("automatic LLM fallback is guarded on close and literal ∅ is preserved", async ({ page }) => {
  await mount(page, 2, false, ["∅", " source "]);
  await expect.poll(() => page.evaluate("pendingLlm.length")).toBe(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(`pendingLlm.shift()({content: JSON.stringify({pairs:[{from_parts:['∅',' source '],to_parts:['manual','search-only'],why:'late'}]})})`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate("accepted.length")).toBe(0);
  await page.evaluate("patch({open: true})");
  await page.getByText("Search other records").click();
  await expect(page.getByRole("searchbox")).toBeVisible();
  await page.getByRole("searchbox").fill("search-only");
  await page.getByRole("radio", { name: /search-only/ }).check();
  await page.getByRole("button", { name: "Add to mapping" }).click();
  expect(await page.evaluate("accepted[0].fromParts")).toEqual(["∅", " source "]);
});

test("empty and NULL sources are shown without conversion and cannot be confirmed", async ({ page }) => {
  await mount(page, 2, true, [null, ""]);
  await expect(page.getByText(/NULL cannot be represented/).first()).toBeVisible();
  expect(await page.evaluate("calls.find(c => c.cmd === 'join_key_fuzzy_suggest').args.tuple.source_parts")).toEqual([null, ""]);
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
  expect(await page.evaluate("calls.filter(c => c.cmd === 'llm_chat').length")).toBe(0);
});

test("late tuple retrieval cannot restore a previous source or its selection", async ({ page }) => {
  await mount(page, 2);
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeEnabled();
  await page.evaluate("holdSuggest = true; patch({fromParts: ['older', 'EU']})");
  await expect.poll(() => page.evaluate("pendingSuggest.length")).toBe(1);
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
  await page.evaluate("patch({fromParts: ['current', 'US']})");
  await expect.poll(() => page.evaluate("pendingSuggest.length")).toBe(2);
  await page.evaluate("pendingSuggest.pop()()");
  await expect(page.getByRole("region", { name: "Source tuple" }).getByText('"current"', { exact: true })).toBeVisible();
  await page.evaluate("pendingSuggest.pop()()");
  await expect(page.getByRole("region", { name: "Source tuple" }).getByText('"older"', { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeDisabled();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 640, height: 540 }, { width: 390, height: 700 }]) {
  test(`stable styled shell through search, LLM, and internal scrolling at ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await mount(page, 5, true, undefined, { holdSuggest: true });
    const dialog = page.getByRole("dialog");
    const rank = page.getByRole("button", { name: "Ask LLM to rank candidates", exact: true });
    const footer = dialog.locator("footer");
    const shell = await dialog.boundingBox();
    const footerBox = await footer.boundingBox();
    const rankBox = await rank.boundingBox();
    expect(shell!.width).toBe(Math.min(840, viewport.width - 32));
    expect(shell!.height).toBe(Math.min(740, viewport.height - 32));
    await expect(rank).toBeVisible();
    await expect(rank).toBeDisabled();
    await expect(page.getByRole("searchbox")).toBeHidden();
    await expect.poll(() => page.evaluate("pendingSuggest.length")).toBe(1);
    await page.evaluate("holdSuggest = false; pendingSuggest.shift()()");
    await expect(rank).toBeEnabled();
    await expect(page.getByRole("heading", { name: /Fuzzy suggestions/ })).toBeVisible();
    expect(await dialog.boundingBox()).toEqual(shell);
    expect(await footer.boundingBox()).toEqual(footerBox);
    expect(await rank.boundingBox()).toEqual(rankBox);
    await rank.click();
    const busy = page.getByRole("button", { name: "Asking LLM…", exact: true });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
    expect(await dialog.boundingBox()).toEqual(shell);
    await page.evaluate(`pendingLlm.shift()({content: JSON.stringify({pairs:[{from_parts:source,to_parts:fixture.tuple_report.right_universe[1].parts,why:'Complete tuple evidence'}]})})`);
    await expect(rank).toBeEnabled();
    await expect(page.getByText("Complete tuple evidence", { exact: true })).toBeAttached();
    expect(await dialog.boundingBox()).toEqual(shell);
    await page.getByText("Search other records").click();
    await page.getByRole("searchbox").fill("search-only");
    await page.getByTestId("find-right-scroll").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(rank).toBeInViewport();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    expect(await footer.boundingBox()).toEqual(footerBox);
    expect(await dialog.boundingBox()).toEqual(shell);
    await page.getByTestId("find-right-scroll").evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath(`suggest-right-${viewport.width}.png`) });
  });
}

test("unconfigured provider keeps ranking discoverable with configuration guidance", async ({ page }) => {
  await mount(page, 2, true, undefined, { noProvider: true });
  const rank = page.getByRole("button", { name: "Ask LLM to rank candidates", exact: true });
  await expect(rank).toBeVisible();
  await expect(rank).toBeDisabled();
  await expect(rank).toHaveAccessibleDescription(/Configure a provider URL and model in Options/);
  await page.getByText("Search other records").click();
  await page.getByRole("searchbox").fill("search-only");
  await page.getByRole("radio", { name: /search-only/ }).check();
  await expect(page.getByRole("button", { name: "Add to mapping" })).toBeEnabled();
  expect(await page.evaluate("calls.filter(c => c.cmd === 'llm_chat').length")).toBe(0);
});
