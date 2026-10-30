import { useEffect, useMemo, useState } from "react";
import type { ConnectionDef, Workspace } from "../types/pipeline";
import {
  getLlmConfig,
  joinKeyFuzzySuggest,
  llmChat,
  setLlmConfig,
  type JoinKeyFuzzySuggest,
  type LlmConfig,
} from "../lib/bridge";

type ChatMsg = { role: "user" | "assistant"; content: string };

type SuggestedPair = { from: string; to: string; why?: string };

function parseSuggestedPairs(text: string): SuggestedPair[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw =
    fence?.[1] ??
    text.match(/\{[\s\S]*"pairs"\s*:[\s\S]*\}/)?.[0];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      pairs?: { from?: string; to?: string; why?: string }[];
    };
    if (!Array.isArray(parsed.pairs)) return [];
    return parsed.pairs
      .map((p) => ({
        from: String(p.from ?? "").trim(),
        to: String(p.to ?? "").trim(),
        why: p.why?.trim() || undefined,
      }))
      .filter((p) => p.from && p.to);
  } catch {
    return [];
  }
}

function fmtCols(cols: { name: string; type: string }[]): string {
  if (!cols.length) return "(schema unavailable)";
  return cols.map((c) => `${c.name}:${c.type}`).join(", ");
}

function fmtSamples(samples: JoinKeyFuzzySuggest["chat_context"]["leftover_left_samples"]): string {
  if (!samples.length) return "(no row samples)";
  return samples
    .map((s) => {
      const fields = s.fields.map((f) => `${f.name}=${JSON.stringify(f.value)}`).join("; ");
      return `- key=${JSON.stringify(s.key)} | ${fields || "(key only)"}`;
    })
    .join("\n");
}

function systemPrompt(report: JoinKeyFuzzySuggest): string {
  const ctx = report.chat_context;
  const cap = 80;
  const left = report.leftover_left.slice(0, cap);
  const right = report.leftover_right.slice(0, cap);
  const moreLeft = report.leftover_left.length - left.length;
  const moreRight = report.leftover_right.length - right.length;
  const fuzzyExamples = report.suggestions.slice(0, 12).map(
    (p) =>
      `- ${JSON.stringify(p.from_key)} → ${JSON.stringify(p.to_key)} (jaro=${p.score.toFixed(3)}, edits=${p.edits}${p.ambiguous ? ", ambiguous" : ""})`,
  );
  const aliasExamples = ctx.existing_aliases.slice(0, 20).map(
    (a) =>
      `- [${a.map_name || a.map_id}] ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}`,
  );
  return [
    "You help map join keys inside DWHForge Query.",
    "Two tables/queries are joined on the key columns below. Fuzzy Jaro-Winkler already proposed close spellings; you only discuss leftover keys that still have no partner.",
    "Use the join lineage, column schemas, neighbor-field samples, existing KeyMap aliases, and fuzzy examples to infer the business domain (channels, companies, SKUs, regions, etc.).",
    "Never invent a key that is not in the leftover lists. Never suggest changing Join ON to a fuzzy predicate.",
    "Propose From (left leftover) → To (right leftover) only when they are the same business entity under different spellings/codes/aliases.",
    "If neighbor fields conflict (different cities, brands, amounts that clearly belong to different entities), refuse the pair.",
    "Explain briefly using domain evidence from the samples. If you propose pairs, end with a json fence:",
    '{"pairs":[{"from":"<exact leftover left>","to":"<exact leftover right>","why":"<short evidence>"}]}',
    'If none are safe, end with {"pairs":[]}.',
    "",
    "## Join",
    `Host query: ${ctx.left_query_name} (${ctx.left_query_id}) step ${report.join_step_index}`,
    `Right query: ${ctx.right_query_name} (${ctx.right_query_id})`,
    `Left ON: ${report.left_on.join(", ") || "(none)"}`,
    `Right ON: ${report.right_on.join(", ") || "(none)"}`,
    `Left lineage: ${ctx.left_lineage || "(unknown)"}`,
    `Right lineage: ${ctx.right_lineage || "(unknown)"}`,
    `Left columns: ${fmtCols(ctx.left_columns)}`,
    `Right columns: ${fmtCols(ctx.right_columns)}`,
    "",
    "## Fuzzy suggestions already offered (spelling-near; do not repeat unless rejecting)",
    fuzzyExamples.join("\n") || "(none)",
    "",
    "## Existing KeyMap aliases in this project (domain examples)",
    aliasExamples.join("\n") || "(none yet)",
    "",
    `## Leftover left keys (From), ${report.leftover_left.length}`,
    left.map((k) => `- ${k}`).join("\n") || "(none)",
    moreLeft > 0 ? `… and ${moreLeft} more left keys not listed` : "",
    "Sample left rows for leftovers (key + neighbor fields):",
    fmtSamples(ctx.leftover_left_samples),
    "",
    `## Leftover right keys (To), ${report.leftover_right.length}`,
    right.map((k) => `- ${k}`).join("\n") || "(none)",
    moreRight > 0 ? `… and ${moreRight} more right keys not listed` : "",
    "Sample right rows for leftovers (key + neighbor fields):",
    fmtSamples(ctx.leftover_right_samples),
  ].join("\n");
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
  onAccept?: (fromValues: string[], toValues: string[]) => void;
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
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    setChat([]);
    setChatError(null);
    void joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        const next: Record<number, boolean> = {};
        r.suggestions.forEach((p, i) => {
          next[i] = !p.ambiguous;
        });
        setPicked(next);
        setChatOpen(r.suggestions.length === 0 && (r.leftover_left.length > 0 || r.leftover_right.length > 0));
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, hostQueryId, joinStepIndex, connections]);

  const selected = useMemo(() => {
    if (!report) return [];
    return report.suggestions.filter((_, i) => picked[i]);
  }, [report, picked]);

  const lastAssistant = [...chat].reverse().find((m) => m.role === "assistant");
  const chatPairs = useMemo(() => {
    if (!lastAssistant || !report) return [];
    const allowedL = new Set(report.leftover_left);
    const allowedR = new Set(report.leftover_right);
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
    if (!content || !report || chatBusy) return;
    if (!llm?.api_key_set) {
      setShowConn(true);
      setChatError("Set llm.api_key in ~/.dwhforge-query/settings.json");
      return;
    }
    const next: ChatMsg[] = [...chat, { role: "user", content }];
    setChat(next);
    setDraft("");
    setChatBusy(true);
    setChatError(null);
    try {
      const res = await llmChat([
        { role: "system", content: systemPrompt(report) },
        ...next,
      ]);
      setChat([...next, { role: "assistant", content: res.content }]);
    } catch (e) {
      setChatError(typeof e === "string" ? e : String(e));
    } finally {
      setChatBusy(false);
    }
  }

  const leftoverCount =
    (report?.leftover_left.length ?? 0) + (report?.leftover_right.length ?? 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 px-2 py-1">
        <span className="text-[10px] text-slate-400">
          {loading
            ? "Scoring unmatched keys…"
            : report
              ? `${report.suggestions.length} fuzzy pair${report.suggestions.length === 1 ? "" : "s"} · ${report.metric} ≥ ${report.score_cutoff}`
              : "Auto map"}
        </span>
        {report?.truncated && (
          <span className="text-[10px] text-amber-300/90">
            scan capped at {report.scanned_left}+{report.scanned_right}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowConn((v) => !v)}
          className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
        >
          {llm?.api_key_set ? `LLM · ${llm.model}` : "Connect LLM"}
        </button>
      </div>

      {showConn && (
        <div className="shrink-0 space-y-1 border-b border-slate-800 bg-slate-950/80 px-2 py-2 text-[10px]">
          <div className="text-slate-500">
            Writes <span className="font-mono">llm</span> in ~/.dwhforge-query/settings.json
            (OpenAI-compatible <span className="font-mono">/chat/completions</span>, Bearer token).
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
            api_key {llm?.api_key_set ? "(saved — leave blank to keep)" : ""}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
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

      {error && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-2 py-1 text-[10px] text-red-200">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {report && report.suggestions.length === 0 && !loading && (
          <div className="border-b border-slate-800 px-2 py-2 text-[10px] text-slate-400">
            No fuzzy pairs above the cutoff. Leftovers can be discussed in the LLM chat, then
            accepted into the KeyMap. Probe stays manual.
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
              <span className="block truncate font-mono text-amber-50">{p.from_key}</span>
              <span className="block truncate font-mono text-teal-100/90">→ {p.to_key}</span>
              <span className="text-[10px] text-slate-500">
                {p.score.toFixed(3)} · edits {p.edits}
                {p.ambiguous ? " · close second, confirm" : ""}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800 px-2 py-1.5">
        <button
          type="button"
          disabled={!onAccept || selected.length === 0}
          onClick={() =>
            onAccept?.(
              selected.map((p) => p.from_key),
              selected.map((p) => p.to_key),
            )
          }
          className="rounded border border-amber-600/80 bg-amber-500/25 px-2 py-1 text-[10px] font-semibold text-amber-50 disabled:opacity-40"
        >
          Accept {selected.length} into KeyMap…
        </button>
        <button
          type="button"
          onClick={() => setChatOpen((v) => !v)}
          className="rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300"
        >
          {chatOpen ? "Hide chat" : `Discuss leftovers${leftoverCount ? ` · ${leftoverCount}` : ""}`}
        </button>
      </div>

      {chatOpen && report && (
        <div className="flex max-h-[46%] min-h-[9rem] shrink-0 flex-col border-t border-teal-950/70 bg-[#071018]">
          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-2 py-1.5">
            {chat.length === 0 && (
              <div className="text-[10px] leading-relaxed text-slate-500">
                {report.leftover_left.length + report.leftover_right.length === 0
                  ? "No leftover keys. Fuzzy covered the unmatched sample, or both sides already match."
                  : `${report.leftover_left.length} left and ${report.leftover_right.length} right keys have no fuzzy pair. Ask the model; accepted pairs still go through KeyMap.`}
              </div>
            )}
            {chat.map((m, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap text-[10px] leading-relaxed ${
                  m.role === "user" ? "text-slate-200" : "text-teal-100/90"
                }`}
              >
                <span className="mr-1 text-[9px] uppercase text-slate-500">{m.role}</span>
                {m.content}
              </div>
            ))}
            {chatBusy && <div className="text-[10px] text-slate-500">Waiting for the model…</div>}
            {chatError && <div className="text-[10px] text-red-300">{chatError}</div>}
            {chatPairs.length > 0 && (
              <div className="rounded border border-amber-900/50 bg-amber-950/20 p-1.5">
                <div className="mb-1 text-[9px] uppercase text-amber-200/80">
                  Model pairs on the leftover lists
                </div>
                {chatPairs.map((p) => (
                  <div key={`${p.from}→${p.to}`} className="truncate font-mono text-[10px] text-amber-50">
                    {p.from} → {p.to}
                  </div>
                ))}
                <button
                  type="button"
                  disabled={!onAccept}
                  onClick={() =>
                    onAccept?.(
                      chatPairs.map((p) => p.from),
                      chatPairs.map((p) => p.to),
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
                  "Which leftover left keys are safe aliases of leftover right keys? Only use keys from the lists.",
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
        </div>
      )}
    </div>
  );
}
