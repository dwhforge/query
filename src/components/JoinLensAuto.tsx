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

/** Soft budget under host llm_chat per-message limit (12_000). */
const PROMPT_BUDGET = 10_500;

function takeLines(lines: string[], maxChars: number): { text: string; omitted: number } {
  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length;
    if (used + add > maxChars) {
      omitted += 1;
      continue;
    }
    out.push(line);
    used += add;
  }
  return { text: out.join("\n"), omitted };
}

function fmtCols(cols: { name: string; type: string }[], max = 24): string {
  if (!cols.length) return "(schema unavailable)";
  const shown = cols.slice(0, max);
  const extra = cols.length - shown.length;
  return (
    shown.map((c) => `${c.name}:${c.type}`).join(", ") +
    (extra > 0 ? ` …+${extra} cols` : "")
  );
}

function fmtSamples(
  samples: JoinKeyFuzzySuggest["chat_context"]["leftover_left_samples"],
  max = 12,
): string[] {
  return samples.slice(0, max).map((s) => {
    const fields = s.fields
      .slice(0, 4)
      .map((f) => `${f.name}=${JSON.stringify(f.value)}`)
      .join("; ");
    return `- key=${JSON.stringify(s.key)} | ${fields || "(key only)"}`;
  });
}

function systemPrompt(report: JoinKeyFuzzySuggest): string {
  const ctx = report.chat_context;
  const truncNotes: string[] = [];
  if (ctx.context_truncated || report.truncated) {
    truncNotes.push("Context lists were capped for size; prefer listed keys only.");
  }

  const head = [
    "You help map join keys inside DWHForge Query.",
    "Fuzzy Jaro-Winkler already proposed close spellings; discuss leftover left keys that still need a To.",
    "Use join lineage, schemas, neighbor-field samples, KeyMap aliases, and fuzzy examples for domain (tickers, old names, codes).",
    "From must be an exact leftover left key. To must be an exact value from the right-key universe (may already match other left rows — many-to-one is OK).",
    "Never invent keys. Never suggest a fuzzy Join ON.",
    "If neighbor fields conflict, refuse the pair.",
    "Response format (required):",
    "1) First write a short prose rationale (2–6 sentences): for each proposed pair say what evidence you used (ticker/old name/neighbor fields/lineage). If none are safe, say why.",
    "2) Then end with a json fence. Every pair MUST include a non-empty why with the same evidence in one line:",
    '{"pairs":[{"from":"<exact leftover left>","to":"<exact right universe value>","why":"<short evidence>"}]}',
    'or {"pairs":[]}.',
    "Do not output only JSON — the prose rationale comes first.",
    "",
    "## Join",
    `Host: ${ctx.left_query_name} (${ctx.left_query_id}) step ${report.join_step_index}`,
    `Right: ${ctx.right_query_name} (${ctx.right_query_id})`,
    `Left ON: ${report.left_on.join(", ") || "(none)"} · Right ON: ${report.right_on.join(", ") || "(none)"}`,
    `Left lineage: ${ctx.left_lineage || "(unknown)"}`,
    `Right lineage: ${ctx.right_lineage || "(unknown)"}`,
    `Left columns: ${fmtCols(ctx.left_columns)}`,
    `Right columns: ${fmtCols(ctx.right_columns)}`,
  ].join("\n");

  let budget = PROMPT_BUDGET - head.length - 80;
  const sections: string[] = [head];

  const pushSection = (title: string, lines: string[], softCap: number) => {
    const room = Math.max(200, Math.min(softCap, budget));
    const { text, omitted } = takeLines(lines, room);
    if (!text && omitted === 0) {
      sections.push(`\n## ${title}\n(none)`);
      return;
    }
    const note = omitted > 0 ? `\n… omitted ${omitted} more lines` : "";
    if (omitted > 0) truncNotes.push(`${title}: omitted ${omitted}`);
    const block = `\n## ${title}\n${text || "(none)"}${note}`;
    sections.push(block);
    budget -= block.length;
  };

  pushSection(
    "Fuzzy suggestions already offered",
    report.suggestions.slice(0, 10).map(
      (p) =>
        `- ${JSON.stringify(p.from_key)} → ${JSON.stringify(p.to_key)} (jaro=${p.score.toFixed(3)}${p.ambiguous && p.alt_to_key ? `; alt ${JSON.stringify(p.alt_to_key)}` : ""})`,
    ),
    1200,
  );
  pushSection(
    "Existing KeyMap aliases",
    ctx.existing_aliases
      .slice(0, 12)
      .map(
        (a) =>
          `- [${a.map_name || a.map_id}] ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}`,
      ),
    1000,
  );
  const leftKeys = report.leftover_left.slice(0, 40).map((k) => `- ${k}`);
  pushSection(
    `Leftover left (From), ${report.leftover_left.length}`,
    leftKeys,
    2000,
  );
  pushSection("Left leftover samples", fmtSamples(ctx.leftover_left_samples, 10), 2200);
  const universe = (ctx.right_to_universe ?? []).slice(0, 40).map((k) => `- ${k}`);
  pushSection(
    `Right key universe (allowed To), ${(ctx.right_to_universe ?? []).length}`,
    universe,
    1800,
  );
  pushSection(
    `Unmatched right (still open), ${report.leftover_right.length}`,
    report.leftover_right.slice(0, 30).map((k) => `- ${k}`),
    1200,
  );
  pushSection("Right leftover samples", fmtSamples(ctx.leftover_right_samples, 8), 1800);

  if (truncNotes.length) {
    sections.push(`\n## Truncation\n- ${truncNotes.join("\n- ")}`);
  }
  let out = sections.join("\n");
  if (out.length > PROMPT_BUDGET) {
    out = `${out.slice(0, PROMPT_BUDGET - 40)}\n…[prompt truncated]`;
  }
  return out;
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
    let cancelled = false;
    chatGen.current += 1;
    setLoading(true);
    setError(null);
    setReport(null);
    setChat([]);
    setChatError(null);
    setChatBusy(false);
    void joinKeyFuzzySuggest(workspace, hostQueryId, joinStepIndex, connections)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        const next: Record<number, boolean> = {};
        r.suggestions.forEach((p, i) => {
          next[i] = !p.ambiguous;
        });
        setPicked(next);
        const openChat =
          !r.disabled_reason &&
          r.suggestions.length === 0 &&
          (r.leftover_left.length > 0 || r.leftover_right.length > 0);
        setChatOpen(openChat);
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      chatGen.current += 1;
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
        { role: "system", content: systemPrompt(report) },
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800/80 px-2 py-1">
        <span className="text-[10px] text-slate-400">
          {loading
            ? "Scoring unmatched keys…"
            : report?.disabled_reason
              ? "Auto unavailable for this Join"
              : report
                ? `${report.suggestions.length} fuzzy pair${report.suggestions.length === 1 ? "" : "s"} · ${report.metric} ≥ ${report.score_cutoff}`
                : "Auto map"}
        </span>
        {report?.truncated && !report.disabled_reason && (
          <span className="text-[10px] text-amber-300/90">
            scan capped at {report.scanned_left}+{report.scanned_right}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowConn((v) => !v)}
          className="ml-auto rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
        >
          {llm ? `LLM · ${llm.model}` : "Connect LLM"}
        </button>
      </div>

      {report?.disabled_reason && (
        <div className="shrink-0 border-b border-amber-900/50 bg-amber-950/25 px-2 py-2 text-[10px] leading-relaxed text-amber-100/90">
          {report.disabled_reason}
        </div>
      )}

      {showConn && (
        <div className="shrink-0 space-y-1 border-b border-slate-800 bg-slate-950/80 px-2 py-2 text-[10px]">
          <div className="text-slate-500">
            Writes <span className="font-mono">llm</span> in ~/.dwhforge-query/settings.json
            (OpenAI-compatible <span className="font-mono">/chat/completions</span>).
            API key optional for local endpoints without auth.
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

      {error && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-2 py-1 text-[10px] text-red-200">
          {error}
        </div>
      )}

      <div
        className={`min-h-0 overflow-auto ${
          chatOpen ? "max-h-[30%] shrink-0" : "flex-1"
        }`}
      >
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
                {p.ambiguous
                  ? ` · close second${p.alt_to_key ? ` (${p.alt_to_key})` : ""}, confirm`
                  : ""}
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
        <div className="flex min-h-0 flex-1 flex-col border-t border-teal-950/70 bg-[#071018]">
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
        </div>
      )}
    </div>
  );
}
