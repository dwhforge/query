import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import {
  getLlmConfig, joinKeyFuzzySuggest, llmChat,
  type JoinKeyFuzzySuggest, type JoinTupleCandidate, type ProjectRefContext,
} from "../lib/bridge";
import { joinTupleLlmPrompt, parseSuggestedTuplePairs } from "../lib/joinLensLlmPrompt";
import {
  findTupleSource, searchRightTuples, tupleCell, tupleCounts, tupleIdentity,
  tupleMappingBlock, type TupleParts,
} from "../lib/joinLensTuple";
import { confirmTupleMapping, type LensTupleMapping } from "../lib/joinLensConfirm";

const EMPTY_SOURCES: SourceDef[] = [];

/** Field-by-field review: display labels never become mapping identities. */
export function TupleFields({ leftOn, rightOn, source, target }: {
  leftOn: string[]; rightOn: string[]; source: TupleParts; target?: TupleParts;
}) {
  return <table className="w-full table-fixed text-left text-xs">
    <thead className="text-[10px] text-slate-500"><tr><th className="pb-1 font-medium">{target ? "Field (source → right)" : "Source field"}</th><th className="pb-1 font-medium">Source value</th>{target && <><th className="pb-1 font-medium">Candidate value</th><th className="w-16 pb-1 font-medium">Difference</th></>}</tr></thead>
    <tbody>{source.map((value, i) => <tr key={i} className="border-t border-slate-800/70 align-top">
      <td className="break-words py-1 pr-2 text-slate-400">{leftOn[i] ?? `Field ${i + 1}`}{target && <span className="block text-slate-500">→ {rightOn[i]}</span>}</td>
      <td className="break-all whitespace-pre-wrap py-1 pr-2 font-mono">{tupleCell(value)}</td>
      {target && <><td className="break-all whitespace-pre-wrap py-1 pr-2 font-mono">{tupleCell(target[i] ?? null)}</td>
        <td className={`py-1 text-[11px] ${value === target[i] ? "text-slate-500" : "text-amber-200"}`}>{value === target[i] ? "Same" : "Changed"}</td></>}
    </tr>)}</tbody>
  </table>;
}

export function FindRightDialog({ open, fromParts, workspace, hostQueryId, joinStepIndex,
  connections, sources = EMPTY_SOURCES, projectRef, onClose, onAccept,
}: {
  open: boolean;
  fromParts: TupleParts;
  workspace: Workspace;
  hostQueryId: string;
  joinStepIndex: number;
  connections: ConnectionDef[];
  sources?: SourceDef[];
  projectRef?: ProjectRefContext;
  onClose: () => void;
  onAccept: (mapping: LensTupleMapping) => void;
}) {
  // Value-based ownership avoids restarting retrieval for new array identities.
  // Include project refs / execution / connections, not just the displayed key.
  const context = JSON.stringify({ open, fromParts, workspace, hostQueryId, joinStepIndex, connections, sources, projectRef });
  const liveContext = useRef(context);
  liveContext.current = context;
  const generation = useRef(0);
  const [result, setResult] = useState<{ context: string; report: JoinKeyFuzzySuggest } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [llmAllowed, setLlmAllowed] = useState(false);
  const [llmConfigLoading, setLlmConfigLoading] = useState(true);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmNote, setLlmNote] = useState<string | null>(null);
  const [llmCandidates, setLlmCandidates] = useState<{ index: number; why: string }[]>([]);
  const report = result?.context === context ? result.report : null;
  const tuple = report?.tuple_report;
  const source = tuple ? findTupleSource(tuple, fromParts) : undefined;
  const sourceBlock = tupleMappingBlock(fromParts);

  function close() {
    generation.current++;
    onClose();
  }

  async function askLlm(r: JoinKeyFuzzySuggest, owned: () => boolean) {
    const tuples = r.tuple_report;
    if (!tuples || !owned()) return;
    const { prompt, allowed } = joinTupleLlmPrompt(tuples, fromParts);
    if (!allowed.length) {
      setLlmError("No complete right tuples fit the LLM context. Use manual search.");
      return;
    }
    setLlmBusy(true);
    setLlmError(null);
    try {
      const res = await llmChat([
        { role: "system", content: prompt },
        { role: "user", content: "Review this complete source tuple and suggest only exact allowed right tuples." },
      ]);
      if (!owned()) return;
      setLlmNote(res.content);
      const pairs = parseSuggestedTuplePairs(res.content, fromParts, allowed);
      setLlmCandidates(pairs.flatMap((p) => {
        const index = tuples.right_universe.findIndex((v) => tupleIdentity(v.parts) === tupleIdentity(p.to_parts));
        return index < 0 ? [] : [{ index, why: p.why }];
      }));
      // No model response (or fuzzy score) selects a target on the user's behalf.
    } catch (e) {
      if (owned()) setLlmError(String(e));
    } finally {
      if (owned()) setLlmBusy(false);
    }
  }

  useEffect(() => {
    const token = ++generation.current;
    let cancelled = false;
    const owned = () => !cancelled && generation.current === token && liveContext.current === context;
    if (!open) return;
    setLoading(true); setResult(null); setError(null); setPicked(null); setFilter("");
    setLlmCandidates([]); setLlmNote(null); setLlmError(null); setLlmBusy(false); setLlmAllowed(false); setLlmConfigLoading(true);
    const config = getLlmConfig().then((cfg) => {
      const allowed = !!cfg.base_url?.trim() && !!cfg.model?.trim();
      if (owned()) setLlmAllowed(allowed);
      return allowed;
    }).catch(() => false).finally(() => { if (owned()) setLlmConfigLoading(false); });
    void (async () => {
      try {
        const r = await joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections,
          sources, null, null, projectRef, { source_parts: fromParts });
        if (!owned()) return;
        if (!r.tuple_report) throw new Error("Tuple suggestions are unavailable from this host. Update the host and retry.");
        if (r.host_query_id !== hostQueryId || r.join_step_index !== joinStepIndex) throw new Error("Suggestion context changed. Reopen Suggest Right.");
        setResult({ context, report: r }); setLoading(false);
        const focused = findTupleSource(r.tuple_report, fromParts);
        const fuzzyHit = focused?.candidates.some((c) => c.score != null && c.score >= r.score_cutoff);
        if (!r.disabled_reason && focused && !sourceBlock && !fuzzyHit && await config && owned()) {
          await askLlm(r, owned);
        }
      } catch (e) {
        if (owned()) { setError(String(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; generation.current++; };
    // context contains all semantic dependencies; object identity must not re-run the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const fuzzy = source?.candidates.filter((c) => c.score != null && c.score >= (report?.score_cutoff ?? 1)) ?? [];
  const manual = useMemo(() => tuple ? searchRightTuples(tuple, filter) : [], [tuple, filter]);
  const selected = picked != null ? tuple?.right_universe[picked] : undefined;
  const block = sourceBlock ?? (selected ? tupleMappingBlock(selected.parts) : null);
  const canAccept = !!source && !!selected && !block && !report?.disabled_reason;
  const candidateByIndex = new Map(source?.candidates.map((c) => [c.right_index, c]));
  const llmDisabledReason = llmConfigLoading ? "Checking LLM configuration…"
    : !llmAllowed ? "Configure a provider URL and model in Options → LLM to enable ranking."
    : loading ? "Waiting for candidate search…"
    : error ? "Candidate search failed. Reopen Suggest Right to retry."
    : report?.disabled_reason ?? sourceBlock ?? (!source ? "Source tuple is unavailable." : null);

  function candidate(index: number, label: string, details?: JoinTupleCandidate, why?: string) {
    const row = tuple?.right_universe[index];
    if (!row || !tuple) return null;
    return <li key={`${label}:${index}`} className={`rounded-lg border p-2.5 ${picked === index ? "border-teal-600 bg-teal-950/30" : "border-slate-700 bg-slate-950/40"}`}>
      <label className="flex cursor-pointer items-start gap-2">
        {/* A tuple may appear in several views. Mirror the single picked index
            across view-local groups so native radio grouping cannot uncheck it. */}
        <input type="radio" className="mt-0.5 shrink-0 accent-teal-400 focus-visible:outline-2 focus-visible:outline-teal-400" name={`suggest-right-${label}`} checked={picked === index} onChange={() => setPicked(index)} aria-label={`Select ${row.parts.map(tupleCell).join(" / ")}`} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-xs text-teal-200">{label}{details?.score != null ? ` · score ${details.score.toFixed(3)}` : ""}</span>
          {label === "Manual" ? <span className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {row.parts.map((value, i) => <span key={i} className="min-w-0 text-xs">
              <span className="text-[10px] text-slate-500">{tuple.right_on[i]} <span className={fromParts[i] === value ? "text-slate-500" : "text-amber-200"}>{fromParts[i] === value ? "· Same" : "· Changed"}</span></span>
              <span className="block break-all whitespace-pre-wrap font-mono">{tupleCell(value)}</span>
            </span>)}
          </span> : <TupleFields leftOn={tuple.left_on} rightOn={tuple.right_on} source={fromParts} target={row.parts} />}
          <span className="block text-[11px] text-slate-400">{tupleCounts(row)} · {fromParts.filter((value, i) => value !== row.parts[i]).length} changed fields</span>
          {details && <span className="block text-[11px] text-slate-500">Field scores: {details.field_scores.map((s) => s == null ? "unscored" : s.toFixed(3)).join(" / ")}</span>}
          {why && <span className="block text-xs text-slate-300">{why}</span>}
          {tupleMappingBlock(row.parts) && <span className="block text-xs text-amber-200">{tupleMappingBlock(row.parts)}</span>}
        </span>
      </label>
    </li>;
  }

  if (!open) return null;
  return <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="find-right-title" className="flex h-[740px] max-h-[calc(100dvh-2rem)] w-full max-w-[840px] flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0a1219] text-slate-200 shadow-2xl shadow-black/50">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div><h2 id="find-right-title" className="text-sm font-semibold text-teal-100">Suggest Right</h2>
          <p className="text-xs text-slate-400">All Join fields are searched together. Choose a complete right tuple explicitly.</p></div>
        <button type="button" className="shrink-0 rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-teal-400" onClick={close}>Close</button>
      </header>
      <div className="grid h-32 shrink-0 grid-cols-1 grid-rows-[34px_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-b border-slate-800 bg-slate-900/40 px-4 py-2.5 sm:h-16 sm:grid-cols-[206px_minmax(0,1fr)] sm:grid-rows-1">
        <button type="button" aria-describedby="find-right-llm-help" aria-busy={llmBusy} disabled={!!llmDisabledReason || llmBusy}
          className="w-[206px] shrink-0 rounded border border-teal-600 bg-teal-500/15 px-3 py-2 text-xs font-semibold text-teal-100 hover:border-teal-400 hover:bg-teal-500/25 focus-visible:outline-2 focus-visible:outline-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            if (!report || llmBusy || llmDisabledReason) return;
            const token = generation.current;
            void askLlm(report, () => generation.current === token && liveContext.current === context);
          }}>{llmBusy ? "Asking LLM…" : "Ask LLM to rank candidates"}</button>
        <p id="find-right-llm-help" role="status" className="min-w-0 text-[11px] leading-relaxed text-slate-400">
          {llmBusy ? "Ranking retrieved candidates… You can still review and select records." : llmDisabledReason ?? "Rank retrieved candidates, including fuzzy hits. You choose the final record."}
        </p>
      </div>
      <div data-testid="find-right-scroll" className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
        <section aria-label="Source tuple" className="rounded-lg border border-slate-800 bg-slate-900/30 p-2.5"><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Source tuple</h3>
          <TupleFields leftOn={tuple?.left_on ?? []} rightOn={tuple?.right_on ?? []} source={fromParts} />
          {source && <p className="mt-1 text-xs text-slate-400">{tupleCounts(source.source)}</p>}
          {sourceBlock && <p role="alert" className="text-xs text-amber-200">{sourceBlock}</p>}
        </section>
        {loading && <p role="status">Searching full tuples…</p>}
        {error && <p role="alert" className="text-rose-300">{error}</p>}
        {report?.disabled_reason && <p role="alert">{report.disabled_reason}</p>}
        {tuple && <>
          <p className="text-xs text-slate-400">Source: {tuple.left_distinct_total} distinct tuples / {tuple.left_occurrences_total} rows. Right: {tuple.right_distinct_total} distinct tuples / {tuple.right_occurrences_total} rows / {Math.max(0, tuple.right_occurrences_total - tuple.right_distinct_total)} duplicate rows.</p>
          {(tuple.left_truncated || tuple.right_truncated) && <p className="text-xs text-amber-200">Bounded results: up to {tuple.tuple_cap} distinct tuples per side. Search and LLM cover retrieved tuples only, not the full dataset.</p>}
          {!source && <p role="alert">This source tuple is no longer available. Reopen Suggest Right from a current row.</p>}
          <section aria-label="Suggestions"><h3 className="mb-2 text-xs font-semibold text-slate-300">Fuzzy suggestions <span className="font-normal text-slate-500">({fuzzy.length})</span></h3>
            {fuzzy.length ? <ul className="space-y-2">{fuzzy.map((c) => candidate(c.right_index, "Fuzzy", c))}</ul> : <p className="text-xs text-slate-400">No fuzzy candidates above cutoff. Use manual search or Ask LLM.</p>}
            {llmCandidates.length > 0 && <><h3 className="mb-2 mt-3 text-xs font-semibold text-teal-200">LLM suggestions ({llmCandidates.length})</h3><ul className="space-y-2">{llmCandidates.map((c) => candidate(c.index, "LLM", candidateByIndex.get(c.index), c.why))}</ul></>}
            {llmError && <p role="alert" className="text-rose-300">{llmError}</p>}
            {llmNote && <details className="mt-2 text-xs"><summary className="cursor-pointer rounded px-2 py-1.5 text-slate-400 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-teal-400">LLM rationale (untrusted suggestions)</summary><pre className="break-all whitespace-pre-wrap p-2 text-slate-400">{llmNote}</pre></details>}
          </section>
          <details key={context} className="rounded-lg border border-slate-700" >
            <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-teal-400">Search other records <span className="font-normal text-slate-500">· {tuple.right_universe.length} retrieved tuples</span></summary>
            <section aria-label="Manual right search" className="border-t border-slate-800 px-3 pb-3">
            <input type="search" aria-label="Search all right tuple fields" placeholder="Search all right fields…" value={filter} onChange={(e) => setFilter(e.target.value)} className="my-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-teal-600 focus:outline-none" />
            <p className="mb-2 text-xs text-slate-500">{manual.length} retrieved tuples match; showing {Math.min(40, manual.length)}.</p>
            <ul className="space-y-2">{manual.slice(0, 40).map((i) => candidate(i, "Manual", candidateByIndex.get(i)))}</ul>
            </section>
          </details>
        </>}
      </div>
      <footer className="flex h-[72px] shrink-0 items-center justify-end gap-3 border-t border-slate-800 px-4 py-3">
        {block && <p role="alert" className="mr-auto max-h-full min-w-0 overflow-y-auto text-xs text-amber-200">{block}</p>}
        {!block && !selected && !loading && <p className="mr-auto max-h-full min-w-0 overflow-y-auto text-xs text-slate-400">Select a complete right record to add it to Mapping.</p>}
        <button type="button" className="shrink-0 rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-teal-400" onClick={close}>Cancel</button>
        <button type="button" disabled={!canAccept} className="shrink-0 rounded border border-amber-600 bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/30 focus-visible:outline-2 focus-visible:outline-amber-400 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => {
          if (!canAccept || !tuple || !selected || result?.context !== liveContext.current) return;
          const confirmed = confirmTupleMapping(tuple.left_on, tuple.right_on, fromParts, selected.parts);
          if ("error" in confirmed) { setError(confirmed.error); return; }
          onAccept(confirmed); close();
        }}>Add to mapping</button>
      </footer>
    </div>
  </div>;
}
