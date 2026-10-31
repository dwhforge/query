import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, Workspace } from "../types/pipeline";
import {
  getLlmConfig,
  joinKeyFuzzySuggest,
  llmChat,
  setLlmConfig,
  type JoinKeyFuzzySuggest,
  type LlmConfig,
} from "../lib/bridge";
import {
  joinKeyMapSystemPrompt,
  parseSuggestedPairs,
} from "../lib/joinLensLlmPrompt";

type ChatMsg = { role: "user" | "assistant"; content: string };

/** Preserve Auto mode selection into ApplyKeyMap columns / output (ADR-0024). */
function acceptApplyOpts(
  leftOn: string[],
  keyIndex: number | null,
  compositeMode: boolean,
  compositeFuzzySlot: number,
): { applyColumns?: string[]; outputColumn?: string } {
  if (compositeMode && leftOn.length > 1) {
    const fuzzy = Math.min(
      compositeFuzzySlot,
      Math.max(0, leftOn.length - 1),
    );
    return {
      applyColumns: [...leftOn],
      outputColumn: leftOn[fuzzy],
    };
  }
  if (keyIndex != null && leftOn[keyIndex]) {
    return {
      applyColumns: [leftOn[keyIndex]!],
      outputColumn: leftOn[keyIndex]!,
    };
  }
  if (leftOn.length === 1) {
    return {
      applyColumns: [leftOn[0]!],
      outputColumn: leftOn[0]!,
    };
  }
  return {};
}

/** Split assistant reply: keep prose visible; tuck fenced JSON behind a toggle. */
function splitAssistantContent(content: string): {
  prose: string;
  jsonFence: string | null;
} {
  const m = content.match(/```(?:json)?\s*[\s\S]*?```/i);
  if (!m || m.index == null) return { prose: content, jsonFence: null };
  const prose = (
    content.slice(0, m.index) + content.slice(m.index + m[0].length)
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { prose: prose || "(pairs below)", jsonFence: m[0] };
}

function AssistantBubble({ content }: { content: string }) {
  const { prose, jsonFence } = splitAssistantContent(content);
  const [showJson, setShowJson] = useState(false);
  return (
    <div className="space-y-1">
      {prose && (
        <div className="whitespace-pre-wrap text-[10px] leading-relaxed text-teal-100/90">
          {prose}
        </div>
      )}
      {jsonFence && (
        <div className="rounded border border-slate-800 bg-slate-950/60">
          <button
            type="button"
            onClick={() => setShowJson((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-1.5 py-1 text-left text-[9px] text-slate-500 hover:text-slate-300"
          >
            <span>Raw JSON output</span>
            <span className="font-mono">{showJson ? "▾ hide" : "▸ show"}</span>
          </button>
          {showJson && (
            <pre className="max-h-40 overflow-auto border-t border-slate-800 px-1.5 py-1 font-mono text-[9px] leading-snug text-slate-500 whitespace-pre-wrap">
              {jsonFence}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function JoinLensAuto({
  workspace,
  hostQueryId,
  joinStepIndex,
  connections,
  onAccept,
}: {
  workspace: Workspace;
  hostQueryId: string;
  joinStepIndex: number;
  connections: ConnectionDef[];
  onAccept?: (
    fromValues: string[],
    toValues: string[],
    opts?: {
      fromParts?: string[][];
      /** Fact columns for ApplyKeyMap (ADR-0024 selected Join keys). */
      applyColumns?: string[];
      /** Column overwritten / written by Apply (per-column or fuzzy slot). */
      outputColumn?: string;
    },
  ) => void;
}) {
  const [report, setReport] = useState<JoinKeyFuzzySuggest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [showConn, setShowConn] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  /** Per-column Suggest on composite Join (ADR-0024). */
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  /** Composite-map mode: use all Join keys as From tuple. */
  const [compositeMode, setCompositeMode] = useState(false);
  const [compositeFuzzySlot, setCompositeFuzzySlot] = useState(0);
  /** Bumps when Join target changes — ignore late LLM replies. */
  const chatGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void getLlmConfig()
      .then((cfg) => {
        if (cancelled) return;
        setLlm(cfg);
        setBaseUrl(cfg.base_url);
        setModel(cfg.model);
      })
      .catch(() => {
        /* connection form still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setKeyIndex(null);
    setCompositeMode(false);
    setCompositeFuzzySlot(0);
  }, [hostQueryId, joinStepIndex]);

  useEffect(() => {
    let cancelled = false;
    chatGen.current += 1;
    setLoading(true);
    setError(null);
    setReport(null);
    setChat([]);
    setChatError(null);
    setChatBusy(false);

    async function run() {
      try {
        // Probe join arity when entering composite mode (need left_on length).
        let result = await joinKeyFuzzySuggest(
          workspace,
          hostQueryId,
          joinStepIndex,
          connections,
          [],
          compositeMode ? null : keyIndex,
          null,
        );
        if (cancelled) return;
        if (compositeMode && result.left_on.length > 1) {
          result = await joinKeyFuzzySuggest(
            workspace,
            hostQueryId,
            joinStepIndex,
            connections,
            [],
            null,
            {
              indices: result.left_on.map((_, i) => i),
              fuzzySlot: Math.min(
                compositeFuzzySlot,
                Math.max(0, result.left_on.length - 1),
              ),
            },
          );
        }
        if (cancelled) return;
        setReport(result);
        const next: Record<number, boolean> = {};
        result.suggestions.forEach((p, i) => {
          next[i] = !p.ambiguous;
        });
        setPicked(next);
        const openChat =
          !result.disabled_reason &&
          result.suggestions.length === 0 &&
          (result.leftover_left.length > 0 || result.leftover_right.length > 0);
        setChatOpen(openChat);
      } catch (e) {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
      chatGen.current += 1;
    };
  }, [
    workspace,
    hostQueryId,
    joinStepIndex,
    connections,
    keyIndex,
    compositeMode,
    compositeFuzzySlot,
  ]);

  const selected = useMemo(() => {
    if (!report) return [];
    return report.suggestions.filter((_, i) => picked[i]);
  }, [report, picked]);

  const lastAssistant = [...chat].reverse().find((m) => m.role === "assistant");
  const chatPairs = useMemo(() => {
    if (!lastAssistant || !report) return [];
    const allowedL = new Set(report.leftover_left);
    const allowedR = new Set([
      ...(report.chat_context.right_to_universe ?? []),
      ...report.leftover_right,
    ]);
    return parseSuggestedPairs(lastAssistant.content).filter(
      (p) => allowedL.has(p.from) && allowedR.has(p.to),
    );
  }, [lastAssistant, report]);

  async function saveConn(clearKey = false) {
    setConnMsg(null);
    try {
      const cfg = await setLlmConfig({
        baseUrl,
        model,
        apiKey: clearKey ? undefined : apiKey,
        clearApiKey: clearKey,
      });
      setLlm(cfg);
      setApiKey("");
      setConnMsg(cfg.api_key_set ? "Saved llm section" : "Saved. API key is empty");
      setShowConn(false);
    } catch (e) {
      setConnMsg(typeof e === "string" ? e : String(e));
    }
  }

  async function sendChat(text: string) {
    const content = text.trim();
    if (!content || !report || chatBusy || report.disabled_reason) return;
    const gen = chatGen.current;
    const joinSnap = `${hostQueryId}:${joinStepIndex}`;
    const next: ChatMsg[] = [...chat, { role: "user", content }];
    setChat(next);
    setDraft("");
    setChatBusy(true);
    setChatError(null);
    try {
      const res = await llmChat([
        { role: "system", content: joinKeyMapSystemPrompt(report) },
        ...next,
      ]);
      if (
        chatGen.current !== gen ||
        `${hostQueryId}:${joinStepIndex}` !== joinSnap
      ) {
        return;
      }
      setChat([...next, { role: "assistant", content: res.content }]);
    } catch (e) {
      if (chatGen.current !== gen) return;
      setChatError(typeof e === "string" ? e : String(e));
    } finally {
      if (chatGen.current === gen) setChatBusy(false);
    }
  }

  const leftoverCount =
    (report?.leftover_left.length ?? 0) + (report?.leftover_right.length ?? 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* —— 1. Fuzzy matcher —— */}
      <section
        className={`flex min-h-0 flex-col border-b border-slate-800 ${
          chatOpen ? "max-h-[38%] shrink-0" : "flex-1"
        }`}
        aria-label="Fuzzy similar names"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-950/40 bg-amber-950/20 px-2 py-1.5">
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200/95">
            Fuzzy
          </span>
          <span className="text-[10px] text-slate-400">
            {loading
              ? "Scoring unmatched keys…"
              : report?.disabled_reason
                ? "Suggestions unavailable for this join"
                : report
                  ? `${report.suggestions.length} similar name${report.suggestions.length === 1 ? "" : "s"} · score ≥ ${report.score_cutoff}`
                  : "Similar-name proposals"}
          </span>
          {report?.truncated && !report.disabled_reason && (
            <span className="text-[10px] text-amber-300/90">
              scan capped at {report.scanned_left}+{report.scanned_right}
            </span>
          )}
        </div>

        {report?.disabled_reason && (
          <div className="shrink-0 space-y-2 border-b border-amber-900/50 bg-amber-950/25 px-2 py-2 text-[10px] leading-relaxed text-amber-100/90">
            <p>{report.disabled_reason}</p>
            {report.left_on.length > 1 && (
              <div className="flex flex-wrap gap-1">
                <span className="w-full text-[9px] text-amber-200/70">
                  Per-column — remap which Join key:
                </span>
                {report.left_on.map((col, i) => (
                  <button
                    key={`${col}-${i}`}
                    type="button"
                    onClick={() => {
                      setCompositeMode(false);
                      setKeyIndex(i);
                    }}
                    className="rounded border border-amber-800/80 bg-amber-950/40 px-1.5 py-0.5 font-mono text-[9px] text-amber-50 hover:border-teal-700"
                  >
                    {col} ↔ {report.right_on[i] ?? "?"}
                  </button>
                ))}
                <span className="mt-1 w-full text-[9px] text-amber-200/70">
                  Or composite map — From tuple (exact on other cols + fuzzy on):
                </span>
                {report.left_on.map((col, i) => (
                  <button
                    key={`comp-${col}-${i}`}
                    type="button"
                    onClick={() => {
                      setKeyIndex(null);
                      setCompositeFuzzySlot(i);
                      setCompositeMode(true);
                    }}
                    className="rounded border border-teal-800/80 bg-teal-950/40 px-1.5 py-0.5 font-mono text-[9px] text-teal-50 hover:border-teal-500"
                  >
                    fuzzy {col}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-2 py-1 text-[10px] text-red-200">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {report && report.suggestions.length === 0 && !loading && (
            <div className="border-b border-slate-800 px-2 py-2 text-[10px] text-slate-400">
              No fuzzy pairs above the cutoff. Use the LLM chat below for leftovers,
              or No match for one-by-one fixes.
            </div>
          )}
          {report?.suggestions.map((p, i) => (
            <label
              key={`${p.from_key}→${p.to_key}`}
              className="flex cursor-pointer items-start gap-2 border-b border-slate-800/70 px-2 py-1.5 text-[11px] hover:bg-slate-900/40"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={!!picked[i]}
                onChange={(e) =>
                  setPicked((prev) => ({ ...prev, [i]: e.target.checked }))
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-amber-50">
                  {p.from_key}
                </span>
                <span className="block truncate font-mono text-teal-100/90">
                  → {p.to_key}
                </span>
                <span className="text-[10px] text-slate-500">
                  fuzzy · {p.score.toFixed(3)} · edits {p.edits}
                  {p.ambiguous
                    ? ` · close second${p.alt_to_key ? ` (${p.alt_to_key})` : ""}, confirm`
                    : ""}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800/80 bg-[#071018]/60 px-2 py-1.5">
          <button
            type="button"
            disabled={!onAccept || selected.length === 0}
            onClick={() =>
              onAccept?.(
                selected.map((p) => p.from_key),
                selected.map((p) => p.to_key),
                {
                  fromParts: selected.map((p) =>
                    p.from_parts?.length ? p.from_parts : [p.from_key],
                  ),
                  ...acceptApplyOpts(
                    report?.left_on ?? [],
                    keyIndex,
                    compositeMode,
                    compositeFuzzySlot,
                  ),
                },
              )
            }
            className="rounded border border-amber-600/80 bg-amber-500/25 px-2 py-1 text-[10px] font-semibold text-amber-50 disabled:opacity-40"
          >
            Accept {selected.length} fuzzy into KeyMap…
          </button>
          {!chatOpen && (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              className="rounded border border-teal-800/70 px-2 py-1 text-[10px] text-teal-200/90 hover:bg-teal-500/10"
            >
              Open LLM chat
              {leftoverCount ? ` · ${leftoverCount} leftovers` : ""}
            </button>
          )}
        </div>
      </section>

      {/* —— 2. LLM chat —— */}
      {chatOpen && report && (
        <section
          className="flex min-h-0 flex-1 flex-col bg-[#06141c]"
          aria-label="LLM chat for leftovers"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-teal-950/60 bg-teal-950/30 px-2 py-1.5">
            <span className="rounded bg-teal-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-teal-200/95">
              LLM chat
            </span>
            <span className="text-[10px] text-slate-400">
              Leftovers after fuzzy
              {leftoverCount ? ` · ${leftoverCount} keys` : ""}
            </span>
            <button
              type="button"
              onClick={() => setShowConn((v) => !v)}
              className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
            >
              {llm ? llm.model : "Connect LLM"}
            </button>
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
            >
              Hide
            </button>
          </div>

          {showConn && (
            <div className="shrink-0 space-y-1 border-b border-slate-800 bg-slate-950/80 px-2 py-2 text-[10px]">
              <div className="text-slate-500">
                Writes <span className="font-mono">llm</span> in
                ~/.dwhforge-query/settings.json (OpenAI-compatible{" "}
                <span className="font-mono">/chat/completions</span>). API key
                optional for local endpoints without auth.
              </div>
              <label className="block text-slate-400">
                base_url
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-slate-200 outline-none"
                />
              </label>
              <label className="block text-slate-400">
                model
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-slate-200 outline-none"
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

          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-2 py-1.5">
            {chat.length === 0 && (
              <div className="text-[10px] leading-relaxed text-slate-500">
                {report.leftover_left.length + report.leftover_right.length === 0
                  ? "No leftover keys. Fuzzy covered the unmatched sample, or both sides already match."
                  : `${report.leftover_left.length} left and ${report.leftover_right.length} right keys have no fuzzy pair. Ask the model; accepted pairs still go through KeyMap.`}
              </div>
            )}
            {chat.map((m, i) => (
              <div key={i} className="space-y-0.5">
                <span className="text-[9px] uppercase tracking-wide text-slate-500">
                  {m.role === "user" ? "You" : "Assistant"}
                </span>
                {m.role === "assistant" ? (
                  <AssistantBubble content={m.content} />
                ) : (
                  <div className="whitespace-pre-wrap text-[10px] leading-relaxed text-slate-200">
                    {m.content}
                  </div>
                )}
              </div>
            ))}
            {chatBusy && (
              <div className="text-[10px] text-slate-500">
                Waiting for the model…
              </div>
            )}
            {chatError && (
              <div className="text-[10px] text-red-300">{chatError}</div>
            )}
            {chatPairs.length > 0 && (
              <div className="rounded border border-amber-900/50 bg-amber-950/20 p-1.5">
                <div className="mb-1 text-[9px] uppercase text-amber-200/80">
                  Model pairs on the leftover lists
                </div>
                {chatPairs.map((p) => (
                  <div key={`${p.from}→${p.to}`} className="mb-1 last:mb-0">
                    <div className="truncate font-mono text-[10px] text-amber-50">
                      {p.from} → {p.to}
                    </div>
                    {p.why && (
                      <div className="text-[10px] leading-snug text-slate-400">
                        {p.why}
                      </div>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  disabled={!onAccept}
                  onClick={() =>
                    onAccept?.(
                      chatPairs.map((p) => p.from),
                      chatPairs.map((p) => p.to),
                      acceptApplyOpts(
                        report.left_on,
                        keyIndex,
                        compositeMode,
                        compositeFuzzySlot,
                      ),
                    )
                  }
                  className="mt-1 rounded border border-amber-600/80 px-2 py-0.5 text-[10px] text-amber-50 disabled:opacity-40"
                >
                  Accept these into KeyMap…
                </button>
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-1 border-t border-slate-800 p-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendChat(draft);
                }
              }}
              placeholder="Ask about leftover keys…"
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-[10px] text-slate-200 outline-none"
            />
            <button
              type="button"
              disabled={
                chatBusy ||
                (!report.leftover_left.length && !report.leftover_right.length)
              }
              onClick={() =>
                void sendChat(
                  "Which leftover left keys are safe aliases of values in the right-key universe? Only use keys from the lists. For each pair, explain the evidence (ticker, old legal name, neighbor fields, or lineage) in prose, then end with the JSON pairs including a non-empty why.",
                )
              }
              className="rounded border border-slate-700 px-1.5 py-1 text-[10px] text-slate-300 disabled:opacity-40"
            >
              Ask leftovers
            </button>
            <button
              type="button"
              disabled={chatBusy || !draft.trim()}
              onClick={() => void sendChat(draft)}
              className="rounded border border-teal-800 px-2 py-1 text-[10px] text-teal-100 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
