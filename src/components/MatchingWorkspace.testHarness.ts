import { expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";

// Component contract only. Actual CSV/Rust/atomic App execution is tested in Electron.
const harness = buildSync({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
  import { createElement, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { MatchingWorkspace } from "./src/components/MatchingWorkspace";
  import { emptyMatchingSession } from "./src/app/matching/types";
  import { buildLensMatchingPlan } from "./src/app/matching/planDefaults";
  import { adaptBasicReport, collectBasicDecisions, mergeBasicLlm, reconcileBasicContext, acknowledgeBasicReceipt } from "./src/app/matching/basic";
  import { runAdvancedMatching, commitAdvancedMatching } from "./src/app/matching/advanced";
  const n = window.width;
  const left = Array.from({length:n}, (_, i) => 'left'+i), right = left.map((_, i) => 'right'+i);
  const report = {left_on:left, right_on:right, tuple_cap:200, left_distinct_total:2, left_occurrences_total:5,
    right_distinct_total:2, right_occurrences_total:3, left_truncated:false, right_truncated:false,
    sources:[0,1].map(g => ({source:{parts:left.map((_,i) => 'source'+g+'/'+i), occurrences:g+2},
      candidates:[0,1].map(r => ({right_index:r, score:r===g?.95:.1, field_scores:left.map(()=>r===g?.95:.1)}))})),
    right_universe:[0,1].map(g=>({parts:left.map((_,i)=>'target'+g+'/'+i), occurrences:g+1}))};
  if (window.reportOverride) Object.assign(report, window.reportOverride);
  if (window.nullSource) report.sources[0].source.parts[0] = null;
  if (window.incomplete) report.right_truncated = true;
  window.report = report; window.calls = []; window.pendingLlm = []; window.saved = [];
  window.dwh = {invoke: async(cmd,args) => {
    window.calls.push({cmd,args});
    if (cmd==='llm_chat') return new Promise((resolve, reject) => window.pendingLlm.push({resolve, reject}));
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
        scope: "full", semanticRevision: semRev, uiRevision: 0 },
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
    const [session,setSession] = useState(emptyMatchingSession({id:'browser', title:'Basic review', entry:'lens', scope:window.scope ?? 'full',
      instructionText:'Review tuples', hasUnsavedDecisions:false, chatCollapsed:false,
      joinBinding:{projectIdentity:'p:0',contextFingerprint:'local',hostQueryId:'fact',joinStepIndex:1,leftOn:left,rightOn:right,rightQueryId:'dim'},
      lensCtx:{hostQueryId:'fact',joinStepIndex:1,leftOn:left,rightOn:right,rightQueryId:'dim',sourceColumns:['vendor_name','region'],targetColumns:['id','vendor_name','region']},
      queryOptions:['fact','dim'],
      plan:buildLensMatchingPlan({leftOn:left,rightOn:right,sourceRef:'fact',targetRef:'dim',targetColumns:['target_id',...right],scope:window.scope ?? 'full'})}));
    const live = { current: session };
    live.current = session;
    window.session = session;
    window.patchSession = patch => setSession(s => ({...s, ...patch}));
    window.changeContext = (identity = 'p:0', fingerprint = 'changed', receipt = null) => setSession(s => reconcileBasicContext(s,identity,fingerprint,receipt));
    window.advancedLive = live;
    // The App's synchronous latest() (pending commit lifecycle) must be visible to the
    // producer commit before React re-renders, so onChange updates the live ref eagerly.
    function commit(next){ live.current = next; window.session = next; setSession(next); }
    return createElement(MatchingWorkspace,{session,onChange:commit,baseline:window.baseline,
      onMergeBasicLlm:(runId,text,sent)=>setSession(s=>mergeBasicLlm(s,runId,text,sent)),
      onRunBasic:async s => { window.calls.push({cmd:'retrieve'});
        if(window.holdRetrieve) await new Promise(resolve => window.releaseRetrieve = resolve);
        if (s.matchingMode === 'advanced') return runAdvancedMatching(s, { execution: {}, targetRef: s.joinBinding.rightQueryId,
          isContextCurrent: () => true,
          acquire: async (args) => { window.calls.push({cmd:'acquire',args}); const snapshot = advSnapshot(args.runId, args.plan.semanticRevision); snapshot.acquisition.joinIndex = args.joinIndex; snapshot.plan.scope = args.plan.scope; return snapshot; },
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
        window.expectedReceipt = {status:'applied',contextFingerprint:'next',projectIdentity:'p:0',joinStepIndex:2,
          appliedCount:s.decisions.filter(d=>d.candidateId).length,matchingSessionId:s.id,matchingRunId:s.basicRun.id};
        if(window.holdWrite) await new Promise(resolve => {window.releaseWrite=resolve;});
        if(window.failWrite) return {status:'error',message:'Apply refused; no publication'};
        const latest = window.advancedLive.current;
        const ack = acknowledgeBasicReceipt(latest, window.expectedReceipt, 'p:0', 'next', null);
        if ('error' in ack) return {status:'error', message:ack.error};
        return {status:'saved',message:'Applied complete tuple mappings',session:ack};
      }});
  }
  const root = createRoot(document.getElementById('root')); window.unmount = () => root.unmount(); root.render(createElement(App));
` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "import.meta.env.DWH_E2E": '"0"', "process.env.NODE_ENV": '"test"' } }).outputFiles[0]!.text;

export async function mount(page: Page, width = 2, options: Record<string, unknown> = {}) {
  await page.route("**/__matching-test.html", route => route.fulfill({ contentType: "text/html", body: '<div id="root" style="height:1000px;display:flex;flex-direction:column"></div>' }));
  await page.goto("/__matching-test.html");
  await page.addStyleTag({ url: "/src/index.css?direct" });
  await page.evaluate(args => Object.assign(window, args), { width, ...options });
  await page.addScriptTag({ content: harness });
  await page.getByRole("button", { name: /Hide how to match|How to match/ }).evaluate((el: HTMLButtonElement) => { if (el.textContent?.includes("How to match")) el.click(); });
  if (options.noRun) return;
  await page.getByTestId("matching-apply-plan").click();
  if (options.holdRetrieve) return;
  await expect(page.locator('tr[data-testid^="matching-row-"]')).toHaveCount(Math.min((options.reportOverride as any)?.sources?.length ?? 2, 50));
  await page.getByText("Review actions — explicit counted bulk", { exact: true }).click();
}
