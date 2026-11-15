import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";

const harness = buildSync({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
  import { createElement, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { JoinLens } from "./src/components/JoinLens";
  window.calls = []; window.pending = []; window.writes = []; window.matching = [];
  window.dwh = { invoke: async (cmd, args) => {
    window.calls.push({cmd, args});
    if (cmd === "join_key_fuzzy_suggest") {
      const r = structuredClone(window.fixture);
      r.host_query_id = args.hostQueryId; r.join_step_index = args.joinStepIndex;
      if (r.tuple_report?.sources[0]) r.tuple_report.sources[0].source.parts = args.tuple.source_parts;
      if (r.tuple_report?.right_universe[0]) r.tuple_report.right_universe[0].parts[0] = "candidate for " + JSON.stringify(args.tuple.source_parts);
      if (window.hold) return new Promise((resolve, reject) => window.pending.push({resolve: () => resolve(r), reject}));
      return r;
    }
    if (cmd === "describe_workspace" || cmd === "preview_workspace") {
      const right = args.workspace.focus_query_id === "dim";
      return {columns: right ? window.rightCols : window.leftCols, rows: []};
    }
    if (cmd === "join_prepare_status") return {prepared: false, stale: false};
    if (cmd === "explain_join_key") return {result_match_count: 0, left_match_count: 1, right_match_count: 0,
      result_columns: window.resultCols, result_rows: []};
    if (cmd === "blame_unmatched_key") return {verdict: "no_partner"};
    if (cmd === "get_llm_config") return {};
    throw new Error("Unexpected command " + cmd);
  }};
  function App() {
    const [props, setProps] = useState(window.initial);
    window.patch = patch => setProps(p => ({...p, ...patch}));
    return createElement(JoinLens, {...props, onMapKey: (...args) => window.writes.push(args),
      onOpenMatching: args => window.matching.push(args)});
  }
  const root = createRoot(document.getElementById("root"));
  window.unmount = () => root.unmount(); root.render(createElement(App));
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "import.meta.env.DWH_E2E": '"0"', "process.env.NODE_ENV": '"test"' },
}).outputFiles[0]!.text;

async function mount(page: Page, width = 2, hold = false) {
  await page.route("**/__candidates.html", route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="height:950px"></div>' }));
  await page.goto("/__candidates.html");
  await page.addStyleTag({ url: "/src/index.css?direct" });
  await page.evaluate(({ width, hold }) => {
    const w = window as any;
    const leftOn = Array.from({ length: width }, (_, i) => `left_${i}`);
    const rightOn = Array.from({ length: width }, (_, i) => `right_${i}`);
    const leftCols = leftOn.map(name => ({ name, type: "VARCHAR" }));
    const rightCols = rightOn.map(name => ({ name, type: "VARCHAR" }));
    const resultCols = [...leftCols, ...rightCols];
    const a = leftOn.map((_, i) => i === 0 ? "shared" : `A${i}`);
    const b = leftOn.map((_, i) => i === 0 ? width === 1 ? "B0" : "shared" : `B${i}`);
    const diagSample = (columns: any[], rows: any[][]) => ({ columns, rows, sample_rows: rows.length, total_count: rows.length });
    Object.assign(w, { hold, leftCols, rightCols, resultCols,
      initial: { enabled: true, workspace: {focus_query_id: "fact", queries: [
        { id: "fact", name: "fact", steps: [{type: "LoadCsv", payload: {path: "left.csv"}},
          {type: "Join", payload: {right_query_id: "dim", left_on: leftOn, right_on: rightOn, join_type: "left"}}]},
        { id: "dim", name: "dim", steps: [{type: "LoadCsv", payload: {path: "right.csv"}}]},
      ]}, hostQueryId: "fact", joinStepIndex: 1, rightQueryId: "dim", leftOn, rightOn,
        connections: [], sources: [], projectIdentity: "project:1", projectRef: {projectUid: "p"},
        columns: resultCols, rows: [a, b].map(p => [...p, ...rightOn.map(() => null)]),
        joinDiag: {unmatched_left_count: 2, unmatched_right_count: 1,
          unmatched_left: diagSample(leftCols, [a, b]),
          unmatched_right: diagSample(rightCols, [rightOn.map((_, i) => `diagnostic ${i}`)])} },
      fixture: { host_query_id: "fact", join_step_index: 1, left_on: leftOn, right_on: rightOn,
        metric: "jaro", score_cutoff: .85, suggestions: [], leftover_left: [], leftover_right: [],
        tuple_report: { left_on: leftOn, right_on: rightOn, tuple_cap: 200,
          sources: [{source: {parts: a, occurrences: 3}, candidates: Array.from({length: 10}, (_, i) => ({right_index: i,
            score: i === 9 ? null : .99 - i * .1, field_scores: leftOn.map((_, j) => j === 1 ? null : .99 - i * .1)})).reverse()}],
          right_universe: Array.from({length: 10}, (_, i) => ({parts: rightOn.map((_, j) => `right ${i}/${j}`), occurrences: i + 1})),
          left_distinct_total: 2, left_occurrences_total: 6, right_distinct_total: 300,
          right_occurrences_total: 500, left_truncated: false, right_truncated: true },
      },
    });
  }, { width, hold });
  await page.addScriptTag({ content: harness });
  await page.getByTestId("join-lens-no-match").click();
}
const pane = (p: Page) => p.getByTestId("join-lens-right-pane");
const calls = (p: Page) => p.evaluate<number>("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').length");

test("normal Find Matches opens honest full input scope without starting retrieval or using selected Lens rows", async ({ page }) => {
  await mount(page, 3);
  await page.getByTestId("join-lens-left-pane").getByRole("button").nth(1).click();
  await expect(page.getByTestId("lens-open-matching")).toHaveAttribute("title", /full JOIN input.*not just selected Lens rows/);
  await page.getByTestId("lens-open-matching").click();
  const entry = await page.evaluate<any>("matching[0]");
  expect(entry.scope).toBe("full");
  expect(entry.leftOn).toEqual(["left_0", "left_1", "left_2"]);
  expect(entry.rightOn).toEqual(["right_0", "right_1", "right_2"]);
  expect(await calls(page)).toBe(0);
  expect(await page.evaluate("writes.length")).toBe(0);
});

async function open(p: Page) { await pane(p).getByRole("button", { name: "Candidates", exact: true }).click(); }
async function source(p: Page, parts: (string | null)[]) {
  await p.evaluate(parts => {
    const w = window as any;
    w.patch({ columns: w.resultCols, rows: [[...parts, ...parts.map(() => null)]],
      joinDiag: {...w.initial.joinDiag, unmatched_left: {...w.initial.joinDiag.unmatched_left, rows: [parts]}} });
  }, parts);
  await expect(p.getByTestId("candidate-source")).toContainText(parts.map(v => v === null ? "NULL" : JSON.stringify(v)).at(-1)!);
}

for (const width of [1, 2, 3, 4, 5]) test(`${width} keys: lazy full tuples, Top-8 ordered scores, incomplete evidence, no writes`, async ({ page }) => {
  await mount(page, width);
  expect(await calls(page)).toBe(0);
  await expect(pane(page)).toContainText("diagnostic 0");
  await expect(page.getByRole("button", { name: "Find Matches", exact: true })).toHaveCount(1);
  await expect(page.getByText("Contextual matching…", { exact: true })).toHaveCount(0);
  await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  expect(await calls(page)).toBe(1);
  const args = await page.evaluate<any>("calls.find(c => c.cmd === 'join_key_fuzzy_suggest').args");
  expect(args.tuple.source_parts).toEqual(Array.from({length: width}, (_, i) => i === 0 ? "shared" : `A${i}`));
  expect(args.keyIndex).toBeUndefined(); expect(args.compositeIndices).toBeUndefined();
  await expect(page.getByTestId("right-candidate").first()).toContainText("Mean score: 0.990");
  await expect(page.getByTestId("right-candidate").nth(7)).toContainText("Mean score: 0.290");
  await expect(page.getByTestId("candidate-coverage")).toContainText("10 / 300");
  await expect(page.getByText(/Incomplete \/ bounded coverage/)).toBeVisible();
  await page.getByTestId("right-candidate").first().locator("summary").click();
  for (let i = 0; i < width; i++) await expect(page.getByTestId("right-candidate").first()).toContainText(`left_${i} → right_${i}`);
  await expect(page.getByTestId("right-candidate").first()).toContainText("Changed");
  if (width > 1) await expect(page.getByTestId("right-candidate").first()).toContainText("score unknown");
  await pane(page).getByRole("button", { name: "No match", exact: true }).click();
  await expect(pane(page)).toContainText("diagnostic 0");
  await open(page); expect(await calls(page)).toBe(1);
  await expect(page.getByTestId("join-lens-candidates").getByRole("radio")).toHaveCount(0);
  expect(await page.evaluate("writes.length")).toBe(0);
  expect(await page.evaluate("calls.some(c => /llm|matching_|key_map/.test(c.cmd))")).toBe(false);
});

test("LEFT card identity uses every field and new selection requires explicit retrieval", async ({ page }) => {
  await mount(page, 3); await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await page.getByTestId("join-lens-left-pane").getByRole("button").nth(1).click();
  await expect(page.getByTestId("candidate-source")).toContainText('"B2"');
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  expect(await calls(page)).toBe(1);
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  expect(await page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').at(-1).args.tuple.source_parts")).toEqual(["shared", "B1", "B2"]);
});

test("delayed replies cannot survive rapid selection or ABA; fresh explicit retry wins", async ({ page }) => {
  await mount(page, 2, true); await open(page);
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await source(page, ["shared", "B1"]);
  await source(page, ["shared", "A1"]);
  await page.evaluate("pending.shift().resolve()");
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await page.evaluate("pending.shift().resolve()");
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  expect(await calls(page)).toBe(2);
});

test("16-entry LRU touches hits; preserves NULL, empty, whitespace, literal NULL and delimiters", async ({ page }) => {
  await mount(page); await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  const variants: (string | null)[][] = [[null, "x"], ["", "x"], [" ", "x"], ["NULL", "x"], ["∅", "x"], ["a · b", "c"], ["a", "b · c"]];
  for (const parts of [...variants, ...Array.from({length: 8}, (_, i) => [`key ${i}`, "x"])]) {
    await source(page, parts);
    await page.getByRole("button", { name: "Find candidates", exact: true }).click();
    await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  }
  expect(await calls(page)).toBe(16);
  await source(page, ["shared", "A1"]); // touch oldest, preserving it
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await source(page, ["overflow", "x"]);
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await source(page, ["shared", "A1"]);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await source(page, [null, "x"]); // evicted second-oldest
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  expect(await calls(page)).toBe(17);
  const requested = await page.evaluate<any[]>("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').map(c => c.args.tuple.source_parts)");
  expect(requested.slice(1, 8)).toEqual(variants);
});

for (const change of ["project", "connection", "workspace", "references", "sources", "join", "session"]) test(`${change} invalidates cache and pending responses without prefetch`, async ({ page }) => {
  await mount(page); await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await page.evaluate("hold = true");
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await page.evaluate(change => {
    const w = window as any;
    const patches: Record<string, any> = {project: {projectIdentity: "project:2"}, connection: {connections: [{id: "changed"}]},
      workspace: {workspace: {...w.initial.workspace, key_maps: []}}, references: {projectRef: {projectUid: "other"}},
      sources: {sources: [{id: "source"}]}, join: {rightQueryId: "other", joinStepIndex: 2}, session: {forceProbeNonce: 3}};
    w.patch(patches[change]);
  }, change);
  await page.evaluate("pending.shift().resolve()");
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  expect(await calls(page)).toBe(2);
  await page.evaluate("hold = false");
  if (change === "join") await page.getByTestId("join-lens-no-match").click();
  await expect(page.getByTestId("join-lens-candidates")).toBeVisible();
  if (change !== "join") await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
});

test("Candidates precede unchanged Suggest Right modal, diagnostics restore and Matching remains single entry", async ({ page }) => {
  await mount(page); await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await pane(page).getByRole("button", { name: "Suggest…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Suggest Right", exact: true });
  await expect(dialog.getByRole("region", { name: "Source tuple" })).toContainText('"A1"');
  await expect(dialog.getByRole("button", { name: "Add to mapping", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  expect(await page.evaluate("writes.length")).toBe(0);
  await page.getByRole("button", { name: "Find Matches", exact: true }).click();
  expect(await page.evaluate("matching.length")).toBe(1);
  await page.getByRole("button", { name: "All rows", exact: true }).click();
  await expect(page.getByRole("group", { name: "Right panel view", exact: true })).toHaveCount(0);
});

test("error retry, unavailable source, and missing tuple report fail honestly", async ({ page }) => {
  await mount(page, 2, true); await open(page);
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await page.evaluate("pending.shift().reject(new Error('Host refused'))");
  await expect(page.getByRole("alert")).toContainText("Host refused");
  await page.evaluate("hold = false; fixture.tuple_report.sources = []");
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("exact source tuple is unavailable");
  await page.evaluate("fixture.tuple_report = null");
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("Full-tuple candidates are unavailable");
});

test("out-of-order replies do not overwrite newer source results or poison its cache", async ({ page }) => {
  await mount(page, 2, true); await open(page);
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await source(page, ["shared", "B1"]);
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pending.length")).toBe(2);
  await page.evaluate("pending[1].resolve()");
  await expect(page.getByTestId("right-candidate").first()).toContainText('B1');
  await page.evaluate("pending[0].resolve()");
  await expect(page.getByTestId("right-candidate").first()).toContainText('B1');
  await source(page, ["shared", "A1"]);
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  expect(await calls(page)).toBe(2);
});

test("right-only and hypothetical pair selections never become candidate sources", async ({ page }) => {
  await mount(page);
  await pane(page).getByRole("button", { name: /diagnostic 0/ }).click();
  await open(page);
  await expect(page.getByRole("button", { name: "Find candidates", exact: true })).toBeDisabled();
  expect(await calls(page)).toBe(0);
  await page.getByTestId("join-lens-left-pane").getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Find candidates", exact: true })).toBeDisabled();
  expect(await calls(page)).toBe(0);
});

test("hidden project session invalidates results; late failure and NULL-only tuple stay exact", async ({ page }) => {
  await mount(page, 2, true); await open(page);
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await page.evaluate("patch({enabled: false})");
  await page.evaluate("pending.shift().reject(new Error('old error'))");
  await page.evaluate("hold = false; patch({enabled: true})");
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await source(page, [null, null]);
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  expect(await page.evaluate("calls.filter(c => c.cmd === 'join_key_fuzzy_suggest').at(-1).args.tuple.source_parts")).toEqual([null, null]);
});

test("complete coverage and empty candidate results are not fabricated", async ({ page }) => {
  await mount(page);
  await page.evaluate("fixture.tuple_report.right_distinct_total = 10; fixture.tuple_report.right_truncated = false");
  await open(page);
  await expect(page.getByText(/Complete retrieved tuple coverage/)).toBeVisible();
  await page.evaluate("fixture.tuple_report.sources[0].candidates = []; fixture.tuple_report.right_universe = []; fixture.tuple_report.right_distinct_total = 0");
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect(page.getByText("No candidates returned for this tuple.", {exact: true})).toBeVisible();
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
});

test("project context ABA cannot resurrect a cached result, pending success or loading state", async ({ page }) => {
  await mount(page); await open(page);
  await expect(page.getByTestId("right-candidate")).toHaveCount(8);
  await page.evaluate("hold = true");
  await page.getByRole("button", { name: "Find candidates", exact: true }).click();
  await expect.poll(() => page.evaluate("pending.length")).toBe(1);
  await page.evaluate("patch({projectIdentity: 'project:2'})");
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  await page.evaluate("patch({projectIdentity: 'project:1'})");
  await expect(page.getByRole("button", { name: "Find candidates", exact: true })).toBeEnabled();
  await page.evaluate("pending.shift().resolve()");
  await expect(page.getByTestId("right-candidate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find candidates", exact: true })).toBeEnabled();
  expect(await calls(page)).toBe(2);
});
