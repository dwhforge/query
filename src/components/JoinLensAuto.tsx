import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import { getLlmConfig, joinKeyFuzzySuggest, llmChat, setLlmConfig,
  type JoinTupleReport, type LlmConfig, type ProjectRefContext } from "../lib/bridge";
import { confirmTupleMapping, type LensTupleMapping } from "../lib/joinLensConfirm";
import { batchContextFingerprint, BATCH_HISTORY_MESSAGES, BATCH_MESSAGE_CHARS,
  chooseBatchTarget, collectTupleBatch, mergeTupleBatchLlm, tupleBatchLlmPrompt,
  tupleBatchProposals, type TupleBatchProposal } from "../lib/joinLensBatch";
import { searchRightTuples, tupleCell, tupleCounts } from "../lib/joinLensTuple";
import { PanelResizeHandle } from "./PanelResizeHandle";

type ChatMsg = { role: "user" | "assistant"; content: string };
type Props = {
  workspace: Workspace; hostQueryId: string; joinStepIndex: number;
  connections: ConnectionDef[]; sources?: SourceDef[]; projectRef?: ProjectRefContext;
  onAcceptTuples?: (selections: LensTupleMapping[], contextFingerprint: string) => Promise<string | null>;
  /** Legacy caller compatibility only. Full tuple review never invokes scalar writes. */
  onAccept?: (fromValues: string[], toValues: string[], opts?: {
    fromParts?: string[][]; applyColumns?: string[]; outputColumn?: string;
    fromLabels?: (string | null)[]; toLabels?: (string | null)[];
  }) => void;
};
const button = "rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40";
const input = "min-w-0 rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs text-slate-200";
const formatScore = (score: number | null | undefined) => score == null ? "unavailable" : `${Math.round(score * 100)}%`;

/** A new full context owns a new session, including async replies and decisions. */
export function JoinLensAuto(props: Props) {
  const fingerprint = batchContextFingerprint(props.workspace, props.hostQueryId, props.joinStepIndex,
    props.connections, props.sources ?? [], props.projectRef);
  return <TupleBatchSession key={fingerprint} {...props} fingerprint={fingerprint} />;
}

function TupleBatchSession({ workspace, hostQueryId, joinStepIndex, connections, sources = [], projectRef,
  onAcceptTuples, fingerprint }: Props & { fingerprint: string }) {
  const [report, setReport] = useState<JoinTupleReport | null>(null);
  const [proposals, setProposals] = useState<TupleBatchProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [manualPage, setManualPage] = useState(0);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [showConn, setShowConn] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [llmHeight, setLlmHeight] = useState(280);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const generation = useRef(0);
  const commitLock = useRef(false);
  const chatLock = useRef(false);
  const configLock = useRef(false);
  const decisionsRef = useRef(proposals);

  function updateProposals(next: TupleBatchProposal[]) {
    // Publish synchronously as well as to React. Promise callbacks in the same
    // event turn must see an explicit user decision before the next render.
    decisionsRef.current = next;
    setProposals(next);
  }

  useEffect(() => {
    const gen = ++generation.current;
    void joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections, sources,
      null, null, projectRef, {}).then(result => {
      if (generation.current !== gen) return;
      if (!result.tuple_report) throw new Error(result.disabled_reason || "Host did not return full tuple results. Scalar fallback is disabled.");
      const next = tupleBatchProposals(result.tuple_report, result.score_cutoff);
      setReport(result.tuple_report);
      updateProposals(next);
      setActiveId(next[0]?.id ?? null);
    }).catch(e => { if (generation.current === gen) setError(String(e)); })
      .finally(() => { if (generation.current === gen) setLoading(false); });
    return () => { generation.current++; };
    // This component is keyed by the complete canonical context, not object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getLlmConfig().then(cfg => {
      if (cancelled) return;
      setLlm(cfg); setBaseUrl(cfg.base_url || ""); setModel(cfg.model || "");
      setShowConn(!cfg.base_url?.trim() || !cfg.model?.trim());
    }).catch(e => { if (!cancelled) { setShowConn(true); setConnMsg(String(e)); } });
    return () => { cancelled = true; };
  }, []);

  async function saveConn(clearKey = false) {
    if (configLock.current) return;
    setConnMsg(null);
    const url = baseUrl.trim(), mod = model.trim();
    if (!clearKey && (!url || !mod)) { setConnMsg("Enter base_url and model, then Save."); return; }
    const gen = generation.current;
    configLock.current = true; setConfigBusy(true);
    try {
      const cfg = await setLlmConfig({ baseUrl: url, model: mod, apiKey: clearKey ? undefined : apiKey, clearApiKey: clearKey });
      if (generation.current !== gen) return;
      setLlm(cfg); setBaseUrl(cfg.base_url); setModel(cfg.model); setApiKey("");
      setConnMsg(cfg.api_key_set ? "Saved llm section" : "Saved. API key is empty");
      setShowConn(!cfg.base_url.trim() || !cfg.model.trim());
    } catch (e) { if (generation.current === gen) setConnMsg(String(e)); }
    finally { if (generation.current === gen) { configLock.current = false; setConfigBusy(false); } }
  }

  const sent = useMemo(() => report ? tupleBatchLlmPrompt(report, proposals, activeId) : null, [report, proposals, activeId]);
  const configured = !!llm?.base_url?.trim() && !!llm?.model?.trim();
  async function sendChat(text: string) {
    if (!report || !sent?.groups.length || !configured || chatLock.current || commitLock.current || committed || !text.trim()) return;
    const gen = generation.current;
    const request = sent;
    const next: ChatMsg[] = [...chat, { role: "user" as const, content: text.trim().slice(0, BATCH_MESSAGE_CHARS) }]
      .slice(-BATCH_HISTORY_MESSAGES);
    chatLock.current = true; setChatBusy(true); setChatError(null); setChatOpen(true); setChat(next); setDraft("");
    try {
      const result = await llmChat([{ role: "system", content: request.prompt }, ...next]);
      if (generation.current !== gen) return;
      const content = result.content.slice(0, 12_000);
      setChat(prev => [...prev, { role: "assistant" as const, content: content.slice(0, BATCH_MESSAGE_CHARS) }].slice(-BATCH_HISTORY_MESSAGES));
      // Read decisions made while the request was in flight, never its stale snapshot.
      const merged = mergeTupleBatchLlm(report, decisionsRef.current, content, request);
      updateProposals(merged.proposals);
      setNotice(`LLM: ${merged.added} alternatives added; ${merged.duplicates} duplicates merged/ignored; ${merged.conflicts} conflicts ignored. Accepted and skipped decisions were not overwritten.`);
      if (!merged.added && !merged.duplicates && !merged.conflicts) setChatError("No valid complete tuple pairs returned. Invented, partial, wrong-source or out-of-allowlist pairs are rejected.");
    } catch (e) { if (generation.current === gen) setChatError(String(e)); }
    finally { if (generation.current === gen) { chatLock.current = false; setChatBusy(false); } }
  }

  function patch(id: string, change: (p: TupleBatchProposal) => TupleBatchProposal) {
    if (commitLock.current || committed) return;
    updateProposals(decisionsRef.current.map(p => p.id === id ? change(p) : p));
  }
  const active = proposals.find(p => p.id === activeId);
  const source = report && active ? report.sources[active.sourceIndex]?.source : null;
  const acceptedCount = proposals.filter(p => p.decision === "accepted").length;
  const locked = committing || committed;
  const manual = report ? searchRightTuples(report, search) : [];
  const selectedMapping = report && active && source && active.selected != null
    ? confirmTupleMapping(report.left_on, report.right_on, source.parts, report.right_universe[active.selected]!.parts) : null;

  async function commitAccepted() {
    if (!report || !onAcceptTuples || commitLock.current || committed) return;
    const selections = collectTupleBatch(report, decisionsRef.current);
    if ("error" in selections) { setError(selections.error); return; }
    if (!selections.length) return;
    const gen = generation.current;
    commitLock.current = true; setCommitting(true); setError(null);
    try {
      const failure = await onAcceptTuples(selections, fingerprint);
      if (generation.current !== gen) return;
      if (failure) setError(failure);
      else { setCommitted(true); setNotice(`Applied ${selections.length} complete tuple mappings.`); }
    } catch (e) { if (generation.current === gen) setError(String(e)); }
    finally { if (generation.current === gen) { commitLock.current = false; setCommitting(false); } }
  }

  function candidate(rightIndex: number, manualResult = false) {
    if (!report || !active || !source) return null;
    const target = report.right_universe[rightIndex];
    if (!target) return null;
    const score = report.sources[active.sourceIndex]!.candidates.find(c => c.right_index === rightIndex);
    const alternative = active.alternatives.find(a => a.rightIndex === rightIndex);
    const blocked = confirmTupleMapping(report.left_on, report.right_on, source.parts, target.parts);
    return <label key={rightIndex} className={`block rounded border p-2 ${active.selected === rightIndex ? "border-teal-400 bg-teal-950/30" : "border-slate-700"}`}>
      <div className="flex items-center gap-2 text-xs">
        <input type="radio" name={manualResult ? "manual-target" : "proposal-target"} aria-label={`Target ${rightIndex + 1}: ${target.parts.map(tupleCell).join("; ")}`}
          checked={active.selected === rightIndex} disabled={locked || active.decision !== "pending"}
          onChange={() => patch(active.id, p => chooseBatchTarget(p, rightIndex))} />
        <strong>Target {rightIndex + 1}</strong><span>{alternative?.origins.join(" + ") || "manual"} · Score {formatScore(score?.score)}</span>
      </div>
      <div className="my-1 text-xs text-slate-400">{tupleCounts(target)}{target.occurrences > 1 ? " · Duplicate target: Join may multiply rows" : ""}</div>
      <table className="w-full table-fixed text-left text-xs"><thead><tr><th>Join fields</th><th>Source</th><th>Target</th><th>Field score</th></tr></thead>
        <tbody>{report.left_on.map((left, i) => <tr key={i} className={source.parts[i] === target.parts[i] ? "text-slate-300" : "text-amber-200"}>
          <td className="break-words">{left} → {report.right_on[i]}{source.parts[i] !== target.parts[i] ? " ≠" : " ="}</td>
          <td className="whitespace-pre-wrap break-words">{tupleCell(source.parts[i] ?? null)}</td>
          <td className="whitespace-pre-wrap break-words">{tupleCell(target.parts[i] ?? null)}</td>
          <td>{formatScore(score?.field_scores[i])}</td>
        </tr>)}</tbody></table>
      {alternative?.why && <p className="mt-1 text-xs text-teal-200">{alternative.why}</p>}
      {"error" in blocked && <p className="mt-1 text-xs text-red-300">{blocked.error}</p>}
    </label>;
  }

  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden text-slate-200" aria-label="Find Matches">
    <header className="shrink-0 space-y-2 border-b border-slate-700 bg-slate-900 p-2">
      <div className="flex flex-wrap items-center gap-2"><strong>Find Matches</strong>
        <span className="text-xs">{proposals.filter(p => p.alternatives.length > 0).length} suggestions · {acceptedCount} accepted · {proposals.filter(p => p.decision === "pending").length} pending · {proposals.filter(p => p.decision === "skipped").length} skipped · {proposals.filter(p => p.alternatives.length === 0).length} without candidates</span>
        <button className={button} disabled={!acceptedCount || !onAcceptTuples || locked || chatBusy} onClick={() => void commitAccepted()}>{committing ? "Applying…" : committed ? "Applied" : `Write Mapping (${acceptedCount})`}</button>
        <button className={button} onClick={() => setChatOpen(v => !v)}>{chatOpen ? "Hide LLM" : "Open LLM chat"}</button>
        <button className={button} disabled={loading || !configured || !sent?.groups.length || chatBusy || locked} onClick={() => void sendChat("Review the bounded complete source groups and rank safe right tuple alternatives with evidence. Return JSON pairs; do not invent values.")}>{chatBusy ? "Ranking…" : "Ask LLM to rank candidates"}</button>
      </div>
      {!onAcceptTuples && <p className="text-xs text-amber-200">Full tuple Mapping is unavailable in this context. Open the live Join.</p>}
      {!configured && <p className="text-xs text-amber-200">Configure an LLM provider in the chat settings or Options. Manual review is available.</p>}
      {loading && <p role="status">Retrieving complete unmatched tuples…</p>}
      {report && <p className="text-xs">Matching on {report.left_on.length} JOIN fields: {report.left_on.map((field, i) => `${field} ↔ ${report.right_on[i]}`).join("; ")}</p>}
      {report && <p className="text-xs text-slate-400">Bounded results: {report.sources.length}/{report.left_distinct_total} unmatched source tuples ({report.left_occurrences_total} rows), {report.right_universe.length}/{report.right_distinct_total} right tuples ({report.right_occurrences_total} rows). Host cap {report.tuple_cap} per side. {report.left_truncated || report.right_truncated ? "Incomplete retrieval coverage. " : ""}Search is limited to retrieved right tuples, not the warehouse.</p>}
      {sent && <p className="text-xs text-slate-400">LLM coverage: {sent.groups.length} pending source groups; {sent.omittedSources} source groups and {sent.omittedCandidates} candidate slots omitted. Maximum 4 groups × 12 candidates per request; prompt budget may reduce this further. Select a pending queue record to prioritize it. Chat retains at most 6 messages, 4,000 characters each.</p>}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {notice && <p role="status" className="text-xs text-teal-200">{notice}</p>}
    </header>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <nav aria-label="Tuple review queue" className="w-1/3 max-w-72 shrink-0 overflow-auto border-r border-slate-700 p-1">
        {proposals.map(p => <button key={p.id} className={`mb-1 block w-full rounded border p-2 text-left text-xs ${p.id === activeId ? "border-teal-500 bg-teal-950/30" : "border-slate-700"}`}
          onClick={() => { setActiveId(p.id); setSearch(""); setManualPage(0); }}>
          <span className="block break-words whitespace-pre-wrap">{report?.sources[p.sourceIndex]?.source.parts.map(tupleCell).join("; ")}</span>
          <span>{p.decision} · {p.alternatives.length} alternatives</span>
        </button>)}
        {!loading && !proposals.length && <p className="p-2 text-xs">No unmatched source tuples retrieved.</p>}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto p-2" aria-label="Tuple comparison">
        {report && active && source && <>
          <h3 className="text-sm font-semibold">Complete source tuple</h3>
          <dl className="my-2 space-y-1 text-xs">{report.left_on.map((name, i) => <div key={i} className="flex gap-2"><dt>{name}</dt><dd className="break-words whitespace-pre-wrap">{tupleCell(source.parts[i] ?? null)}</dd></div>)}</dl>
          <p className="mb-2 text-xs text-slate-400">{tupleCounts(source)}</p>
          <div className="sticky top-0 z-10 mb-2 flex flex-wrap gap-2 rounded bg-slate-900 p-2">
            <button className={button} disabled={locked || active.decision !== "pending" || !selectedMapping || "error" in selectedMapping}
              onClick={() => patch(active.id, p => ({ ...p, decision: "accepted" }))}>Accept selected</button>
            <button className={button} disabled={locked || active.decision !== "pending"} onClick={() => patch(active.id, p => ({ ...p, decision: "skipped" }))}>Skip</button>
            <button className={button} disabled={locked || active.decision === "pending"} onClick={() => patch(active.id, p => ({ ...p, decision: "pending", selected: null }))}>Undo decision</button>
            <span className="text-xs">{active.decision} · No automatic acceptance</span>
          </div>
          {active.alternatives.length > 1 && <p className="mb-2 text-xs text-amber-200">Ambiguous: multiple alternatives. Compare every field and explicitly choose one.</p>}
          {active.omittedFuzzy > 0 && <p className="text-xs text-amber-200">{active.omittedFuzzy} additional fuzzy alternatives omitted from this shortlist; browse retrieved right tuples below.</p>}
          {!active.alternatives.length && <p className="mb-2 text-xs">No fuzzy candidates above cutoff. Browse retrieved right tuples or ask LLM; this source still needs review.</p>}
          <section aria-label="Proposed alternatives" className="space-y-2">{active.alternatives.map(a => candidate(a.rightIndex))}</section>
          <details className="mt-3 rounded border border-slate-700 p-2"><summary className="cursor-pointer text-xs">Search other records ({report.right_universe.length} complete right tuples)</summary>
            <section aria-label="Manual right search" className="mt-2 space-y-2">
              <input className={input} type="search" aria-label="Search all right tuple fields" placeholder="Search every field…" value={search} onChange={e => { setSearch(e.target.value); setManualPage(0); }} />
              <p className="text-xs text-slate-400">{manual.length} retrieved matches · page {manualPage + 1}/{Math.max(1, Math.ceil(manual.length / 20))}</p>
              {manual.slice(manualPage * 20, (manualPage + 1) * 20).map(i => candidate(i, true))}
              {!manual.length && <p className="text-xs">No retrieved right tuples match this search.</p>}
              <button className={button} disabled={manualPage === 0} onClick={() => setManualPage(p => p - 1)}>Previous records</button>{" "}
              <button className={button} disabled={(manualPage + 1) * 20 >= manual.length} onClick={() => setManualPage(p => p + 1)}>Next records</button>
            </section>
          </details>
        </>}
      </main>
    </div>
    {chatOpen && <section aria-label="LLM batch chat" className="flex shrink-0 flex-col border-t border-slate-600 bg-slate-900" style={{ height: llmHeight, maxHeight: "70%" }}>
      <PanelResizeHandle orientation="horizontal" aria-label="Resize LLM panel" onDelta={dy => setLlmHeight(h => Math.max(140, Math.min(600, h - dy)))} />
      <div className="flex items-center gap-2 p-2 text-xs"><strong>LLM · same review queue</strong><button className={button} onClick={() => setShowConn(v => !v)}>{configured ? model || llm?.model : "Connect LLM"}</button></div>
      <div className="min-h-0 flex-1 overflow-auto px-2">
        <fieldset disabled={configBusy || chatBusy}>
          {(showConn || !baseUrl.trim() || !model.trim()) && (
            <div className="shrink-0 space-y-1 border-b border-slate-800 bg-slate-950/80 px-2 py-2 text-[10px]">
              <div className="text-slate-500">
                {baseUrl.trim() && model.trim()
                  ? <>
                      Writes <span className="font-mono">llm</span> in
                      ~/.dwhforge-query/settings.json (OpenAI-compatible{" "}
                      <span className="font-mono">/chat/completions</span>).
                      API key optional for local endpoints without auth.
                    </>
                  : <>
                      Enter endpoint first — OpenAI-compatible{" "}
                      <span className="font-mono">base_url</span> +{" "}
                      <span className="font-mono">model</span>. Saved to{" "}
                      <span className="font-mono">
                        ~/.dwhforge-query/settings.json
                      </span>
                      .
                    </>}
              </div>
              <label className="block text-slate-400">
                base_url
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…/v1"
                  autoFocus={!baseUrl.trim()}
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-slate-200 outline-none placeholder:text-slate-600"
                />
              </label>
              <label className="block text-slate-400">
                model
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="model id"
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-slate-200 outline-none placeholder:text-slate-600"
                />
              </label>
              <label className="block text-slate-400">
                api_key{" "}
                {llm?.api_key_set
                  ? "(saved — leave blank to keep)"
                  : "(optional for local / no-auth servers)"}
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder="sk-… or empty"
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-slate-200 outline-none"
                />
              </label>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => void saveConn(false)}
                  className="rounded border border-teal-800 px-2 py-0.5 text-teal-200"
                >
                  Save
                </button>
                {llm?.api_key_set && (
                  <button
                    type="button"
                    onClick={() => void saveConn(true)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-slate-400"
                  >
                    Clear key
                  </button>
                )}
              </div>
              {connMsg && <div className="text-amber-200/90">{connMsg}</div>}
            </div>
          )}
        </fieldset>
        {chat.map((m, i) => <div key={i} className="mb-2 text-xs"><strong>{m.role === "user" ? "You" : "Assistant"}</strong>
          <div className="whitespace-pre-wrap break-words text-slate-300">{m.content.replace(/```(?:json)?[\s\S]*?```/i, "[Structured pairs added to the review queue]")}</div>
          {m.content.includes("```") && <details><summary>Raw JSON output</summary><pre className="whitespace-pre-wrap break-words">{m.content}</pre></details>}
        </div>)}
        {chatBusy && <p className="text-xs">Waiting for the model…</p>}
        {chatError && <p role="alert" className="text-xs text-red-300">{chatError}</p>}
      </div>
      <div className="flex gap-2 border-t border-slate-700 p-2">
        <input className={`${input} flex-1`} aria-label="Chat message" placeholder="Ask about complete tuples…" maxLength={BATCH_MESSAGE_CHARS} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void sendChat(draft); } }} />
        <button className={button} disabled={!draft.trim() || !configured || !sent?.groups.length || chatBusy || locked} onClick={() => void sendChat(draft)}>Send</button>
      </div>
    </section>}
  </div>;
}
