import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";

// Component contract only. Actual CSV/Rust/atomic App execution is tested in Electron.
const harness = buildSync({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
  import { createElement, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { MatchingWorkspace } from "./src/components/MatchingWorkspace";
  import { emptyMatchingSession } from "./src/app/matching/types";
  import { buildLensMatchingPlan } from "./src/app/matching/planDefaults";
  import { adaptBasicReport, collectBasicDecisions, mergeBasicLlm } from "./src/app/matching/basic";
  import { runAdvancedMatching, commitAdvancedMatching } from "./src/app/matching/advanced";
  const n = window.width;
  const left = Array.from({length:n}, (_, i) => 'left'+i), right = left.map((_, i) => 'right'+i);
  const report = {left_on:left, right_on:right, tuple_cap:200, left_distinct_total:2, left_occurrences_total:5,
    right_distinct_total:2, right_occurrences_total:3, left_truncated:false, right_truncated:false,
    sources:[0,1].map(g => ({source:{parts:left.map((_,i) => 'source'+g+'/'+i), occurrences:g+2},
      candidates:[0,1].map(r => ({right_index:r, score:r===g?.95:.1, field_scores:left.map(()=>r===g?.95:.1)}))})),
    right_universe:[0,1].map(g=>({parts:left.map((_,i)=>'target'+g+'/'+i), occurrences:g+1}))};
  if (window.nullSource) report.sources[0].source.parts[0] = null;
  if (window.incomplete) report.right_truncated = true;
  window.report = report; window.calls = []; window.pendingLlm = []; window.saved = [];
  window.dwh = {invoke: async(cmd,args) => {
    window.calls.push({cmd,args});
    if (cmd==='llm_chat') return new Promise(resolve => window.pendingLlm.push(resolve));
    throw new Error(cmd);
  }};
  function advSnapshot(runId, semRev){
    const retrieval = {
      candidates: [
        { candidateId: "cand:t1", sessionId: "browser", targetId: "t1", outputValues: ["Acme Inc", "United States"], evidenceRevision: 1 },
        { candidateId: "cand:t2", sessionId: "browser", targetId: "t2", outputValues: ["Widget", "Germany"], evidenceRevision: 1 },
      ],
      proposals: [{ proposalId: "prop:0", sessionId: "browser", mapKey: ["Acme", "US"], affectedSourceRows: 3,
        proposedCandidateId: "cand:t1", alternativeCandidateIds: ["cand:t2"],
        state: "proposed", provenance: "fuzzy", semanticPlanRevision: semRev, evidenceRevision: 1 }],
      metrics: { mode: "trial", keysRequested: 1, keysProcessed: 1, keysUnprocessed: 0, candidatesScored: 2,
        llmCalls: 0, llmRetries: 0, durationMs: 5, stopReason: "complete",
        keyCap: 20, shortlistPerKey: 40, llmPerKey: 10, maxLlmCalls: 220, localUniverse: 10000 },
      llmCandidateIdsByProposal: { "prop:0": ["cand:t1", "cand:t2"] },
      candidateScoresByProposal: { "prop:0": [
        { candidateId: "cand:t1", score: .95, fieldScores: [.9, .95] },
        { candidateId: "cand:t2", score: .4, fieldScores: [.4, .4] }] },
    };
    return {
      sessionId: "browser", runId: runId, evidenceRevision: 1,
      plan: { sourceRef: "fact", targetRef: "dim", mapKeyFields: left.slice(), targetIdentityFields: ["id"],
        comparisons: left.map((f, i) => ({ sourceField: f, targetField: right[i], role: i === 0 ? "soft_signal" : "hard_constraint" })),
        normalization: ["trim"], outputs: right.slice(), ambiguity: "leave_for_manual",
        scope: "cohort", semanticRevision: semRev, uiRevision: 0 },
      acquisition: { queryId: "fact", joinIndex: 1, rightQueryId: "dim", scope: "all",
        sourceFields: left.slice(), targetFields: ["id"].concat(right.slice()),
        sourceRows: [{ mapKey: ["Acme", "US"], fields: {}, affectedSourceRows: 3 }],
        targetRows: [
          { targetId: "t1", identityValues: ["id-1"], fields: { id: "id-1" }, outputValues: ["Acme Inc", "United States"], occurrences: 2 },
          { targetId: "t2", identityValues: ["id-2"], fields: { id: "id-2" }, outputValues: ["Widget", "Germany"], occurrences: 1 }],
        sourceKeyCap: 20, targetRowCap: 10000, targetOccurrences: 3, complete: true },
      retrieval: retrieval,
    };
  }
  function App(){
    const [session,setSession] = useState(emptyMatchingSession({id:'browser', title:'Basic review', entry:'lens', scope:'cohort',
      instructionText:'Review tuples', hasUnsavedDecisions:false, chatCollapsed:false,
      joinBinding:{projectIdentity:'p:0',contextFingerprint:'local',hostQueryId:'fact',joinStepIndex:1,leftOn:left,rightOn:right,rightQueryId:'dim'},
      lensCtx:{hostQueryId:'fact',joinStepIndex:1,leftOn:left,rightOn:right,rightQueryId:'dim',sourceColumns:['vendor_name','region'],targetColumns:['id','vendor_name','region']},
      queryOptions:['fact','dim'],
      plan:buildLensMatchingPlan({leftOn:left,rightOn:right,sourceRef:'fact',targetRef:'dim',targetColumns:['target_id',...right],scope:'cohort'})}));
    const live = { current: session };
    live.current = session;
    window.session = session;
    window.advancedLive = live;
    // The App's synchronous latest() (pending commit lifecycle) must be visible to the
    // producer commit before React re-renders, so onChange updates the live ref eagerly.
    function commit(next){ live.current = next; window.session = next; setSession(next); }
    return createElement(MatchingWorkspace,{session,onChange:commit,
      onMergeBasicLlm:(runId,text,sent)=>setSession(s=>mergeBasicLlm(s,runId,text,sent)),
      onRunBasic:async s => { window.calls.push({cmd:'retrieve'});
        if (s.matchingMode === 'advanced') return runAdvancedMatching(s, { execution: {}, targetRef: s.joinBinding.rightQueryId,
          isContextCurrent: () => true,
          acquire: async (args) => { window.calls.push({cmd:'acquire'}); return advSnapshot(args.runId, args.plan.semanticRevision); },
          latest: () => window.advancedLive.current });
        return adaptBasicReport(s,report,'browser:'+s.generation); },
      onSaveToMap:async({session:s}) => {
        if (s.advancedRun) {
          const receipt = { status: "applied", contextFingerprint: "next", projectIdentity: "p:0",
            joinStepIndex: 2, appliedCount: s.decisions.length,
            matchingSessionId: "browser", matchingRunId: s.advancedRun.id };
          return commitAdvancedMatching(s, { execution: {},
            isContextCurrent: () => true,
            verify: async (args) => { window.calls.push({cmd:'verify'});
              return { sessionId: "browser", runId: args.runId, evidenceRevision: args.evidenceRevision,
                materialized: args.verification.decisions.map(d => ({ sourceParts: d.sourceParts, outputValues: d.outputValues, candidateId: d.candidateId })) }; },
            write: async (latest, materialized) => { window.saved.push(materialized);
              return { result: "applied", message: "Applied " + materialized.length, receipt: receipt }; },
            identity: () => "p:0", fingerprint: () => "next", navigationTarget: () => null,
            latest: () => window.advancedLive.current });
        }
        window.saved.push(collectBasicDecisions(s));
        if(window.holdWrite) await new Promise(resolve => {window.releaseWrite=resolve;});
        if(window.failWrite) return {status:'error',message:'Apply refused; no publication'};
        return {status:'saved',message:'Applied complete tuple mappings',session:{...s, basicRun:undefined,proposals:[],candidates:[],decisions:[],hasUnsavedDecisions:false,
          commitLifecycle:{status:'acknowledged',runId:s.basicRun.id,receipt:{status:'applied',contextFingerprint:'next',projectIdentity:'p:0',joinStepIndex:2,appliedCount:s.decisions.length}}}};
      }});
  }
  createRoot(document.getElementById('root')).render(createElement(App));
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "import.meta.env.DWH_E2E": '"0"', "process.env.NODE_ENV": '"test"' } }).outputFiles[0]!.text;

async function mount(page: Page, width = 2, options = {}) {
  await page.route("**/__matching-test.html", route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="height:1000px;display:flex;flex-direction:column"></div>' }));
  await page.goto("/__matching-test.html");
  await page.addStyleTag({ url: "/src/index.css?direct" });
  await page.evaluate(args => Object.assign(window, args), { width, ...options });
  await page.addScriptTag({ content: harness });
  await page.getByTestId("matching-apply-plan").click();
  await expect(page.locator('tr[data-testid^="matching-row-"]')).toHaveCount(2);
}

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
    w.pendingLlm.shift()({ content: JSON.stringify({ pairs: [{ from_parts: w.report.sources[0].source.parts,
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
