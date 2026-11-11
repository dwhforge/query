import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import {
  getLlmConfig,
  joinKeyFuzzySuggest,
  llmChat,
  setLlmConfig,
  type JoinKeyFuzzySuggest,
  type LlmConfig,
  type ProjectRefContext,
} from "../lib/bridge";
import {
  joinKeyMapSystemPrompt,
  parseSuggestedPairs,
} from "../lib/joinLensLlmPrompt";
import {
  acceptProposal,
  acceptedProposals,
  collectAcceptedPairs,
  pendingProposals,
  proposalsFromFuzzy,
  proposalsFromLlmPairs,
  reopenProposal,
  skipProposal,
  type LensConfirmProposal,
} from "../lib/joinLensConfirm";
import { PanelResizeHandle } from "./PanelResizeHandle";

const LLM_SHEET_MIN = 140;
const LLM_SHEET_DEFAULT = 280;

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

function patchProposal(
  list: LensConfirmProposal[],
  id: string,
  next: LensConfirmProposal,
): LensConfirmProposal[] {
  return list.map((p) => (p.id === id ? next : p));
}

export function JoinLensAuto({
  workspace,
  hostQueryId,
  joinStepIndex,
  connections,
  sources = [],
  projectRef,
  onAccept,
}: {
  workspace: Workspace;
  hostQueryId: string;
  joinStepIndex: number;
  connections: ConnectionDef[];
  sources?: SourceDef[];
  projectRef?: ProjectRefContext;
  /** ADR-0042: commit session-accepted pairs (KeyMap + ApplyKeyMap). */
  onAccept?: (
    fromValues: string[],
    toValues: string[],
    opts?: {
      fromParts?: string[][];
      applyColumns?: string[];
      outputColumn?: string;
      /** Sibling name labels → KeyMap attrs from_name / to_name. */
      fromLabels?: (string | null)[];
      toLabels?: (string | null)[];
    },
  ) => void;
}) {
  const [report, setReport] = useState<JoinKeyFuzzySuggest | null>(null);
  const [proposals, setProposals] = useState<LensConfirmProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [showConn, setShowConn] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  /** Brief entrance cue after "Add LLM leftovers". */
  const [chatReveal, setChatReveal] = useState(false);
  /** LLM bottom-sheet height (px); drag the top splitter. */
  const [llmHeightPx, setLlmHeightPx] = useState(LLM_SHEET_DEFAULT);
  /** Per-column Suggest on composite Join (ADR-0024). */
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  /** Composite-map mode: use all Join keys as From tuple. */
  const [compositeMode, setCompositeMode] = useState(false);
  const [compositeFuzzySlot, setCompositeFuzzySlot] = useState(0);
  /** Bumps when Join target changes — ignore late LLM replies. */
  const chatGen = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chatPanelRef = useRef<HTMLElement | null>(null);
  const chatRevealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clampLlmHeight = useCallback((px: number) => {
    const host = rootRef.current?.clientHeight ?? 480;
    const max = Math.max(LLM_SHEET_MIN + 40, Math.floor(host * 0.85));
    return Math.max(LLM_SHEET_MIN, Math.min(max, Math.round(px)));
  }, []);

  const onLlmResizeDelta = useCallback(
    (dy: number) => {
      // Drag handle at top of sheet: pointer down → shrink sheet.
      setLlmHeightPx((h) => clampLlmHeight(h - dy));
    },
    [clampLlmHeight],
  );

  function openLlmLeftovers() {
    setChatOpen(true);
    setChatReveal(true);
    if (!baseUrl.trim() || !model.trim()) setShowConn(true);
    if (chatRevealTimer.current) clearTimeout(chatRevealTimer.current);
    chatRevealTimer.current = setTimeout(() => setChatReveal(false), 1400);
    requestAnimationFrame(() => {
      chatPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  }

  useEffect(() => {
    return () => {
      if (chatRevealTimer.current) clearTimeout(chatRevealTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getLlmConfig()
      .then((cfg) => {
        if (cancelled) return;
        setLlm(cfg);
        setBaseUrl(cfg.base_url);
        setModel(cfg.model);
        // Empty endpoint → open Connect form; user must enter URL/model first.
        if (!cfg.base_url.trim() || !cfg.model.trim()) {
          setShowConn(true);
        }
      })
      .catch(() => {
        if (!cancelled) setShowConn(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const workspaceRef = useRef(workspace);
  const connectionsRef = useRef(connections);
  const sourcesRef = useRef(sources);
  const projectRefRef = useRef(projectRef);
  workspaceRef.current = workspace;
  connectionsRef.current = connections;
  sourcesRef.current = sources;
  projectRefRef.current = projectRef;

  /** Stable join+mode key — avoid re-fetch loops when parent passes new object identities. */
  const fuzzyFetchKey = `${hostQueryId}#${joinStepIndex}#${keyIndex ?? "all"}#${
    compositeMode ? `c${compositeFuzzySlot}` : "s"
  }`;

  useEffect(() => {
    setKeyIndex((cur) => (cur == null ? cur : null));
    setCompositeMode((cur) => (cur ? false : cur));
    setCompositeFuzzySlot((cur) => (cur === 0 ? cur : 0));
    setChatOpen((cur) => (cur ? false : cur));
    setChatReveal((cur) => (cur ? false : cur));
  }, [hostQueryId, joinStepIndex]);

  useEffect(() => {
    let cancelled = false;
    chatGen.current += 1;
    setLoading(true);
    setError(null);
    setReport(null);
    setProposals([]);
    setChat([]);
    setChatError(null);
    setChatBusy(false);

    async function run() {
      try {
        let result = await joinKeyFuzzySuggest(
          workspaceRef.current,
          hostQueryId,
          joinStepIndex,
          connectionsRef.current,
          sourcesRef.current,
          compositeMode ? null : keyIndex,
          null,
          projectRefRef.current,
        );
        if (cancelled) return;
        if (compositeMode && result.left_on.length > 1) {
          result = await joinKeyFuzzySuggest(
            workspaceRef.current,
            hostQueryId,
            joinStepIndex,
            connectionsRef.current,
            sourcesRef.current,
            null,
            {
              indices: result.left_on.map((_, i) => i),
              fuzzySlot: Math.min(
                compositeFuzzySlot,
                Math.max(0, result.left_on.length - 1),
              ),
            },
            projectRefRef.current,
          );
        }
        if (cancelled) return;
        setReport(result);
        setProposals(proposalsFromFuzzy(result.suggestions));
        const openChat =
          !result.disabled_reason &&
          result.suggestions.length === 0 &&
          (result.leftover_left.length > 0 || result.leftover_right.length > 0);
        // Auto-open once for empty fuzzy (reveal outside the updater).
        if (openChat) {
          setChatOpen((was) => {
            if (was) return true;
            queueMicrotask(() => {
              setChatReveal(true);
              if (chatRevealTimer.current) clearTimeout(chatRevealTimer.current);
              chatRevealTimer.current = setTimeout(
                () => setChatReveal(false),
                1400,
              );
            });
            return true;
          });
        }
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
    // fuzzyFetchKey encodes host/join/mode; live IR read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuzzyFetchKey]);

  const accepted = useMemo(
    () => acceptedProposals(proposals),
    [proposals],
  );
  const pending = useMemo(() => pendingProposals(proposals), [proposals]);

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
    const url = baseUrl.trim();
    const mod = model.trim();
    if (!clearKey && (!url || !mod)) {
      setConnMsg("Enter base_url and model, then Save.");
      setShowConn(true);
      return;
    }
    try {
      const cfg = await setLlmConfig({
        baseUrl: url || baseUrl,
        model: mod || model,
        apiKey: clearKey ? undefined : apiKey,
        clearApiKey: clearKey,
      });
      setLlm(cfg);
      setBaseUrl(cfg.base_url);
      setModel(cfg.model);
      setApiKey("");
      setConnMsg(cfg.api_key_set ? "Saved llm section" : "Saved. API key is empty");
      // Stay open until both fields are set.
      setShowConn(!cfg.base_url.trim() || !cfg.model.trim());
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
      setChat((prev) => [...prev, { role: "assistant", content: res.content }]);
    } catch (e) {
      if (chatGen.current === gen) {
        setChatError(typeof e === "string" ? e : String(e));
      }
    } finally {
      if (chatGen.current === gen) setChatBusy(false);
    }
  }

  /** ADR-0042: LLM queues into the same Lens batch as fuzzy; one Write commits all. */
  function queueLlmPairs(mode: "accepted" | "pending") {
    const ctx = report?.chat_context;
    const added = proposalsFromLlmPairs(chatPairs, proposals, {
      leftLabels: ctx?.left_key_labels,
      rightLabels: ctx?.right_key_labels,
      leftSamples: ctx?.leftover_left_samples,
      rightSamples: ctx?.leftover_right_samples,
    }).map((p) => (mode === "accepted" ? acceptProposal(p) : p));
    if (!added.length) return;
    setProposals((prev) => [...prev, ...added]);
  }

  function commitAccepted() {
    if (!onAccept || accepted.length === 0) return;
    const pairs = collectAcceptedPairs(proposals);
    onAccept(pairs.fromValues, pairs.toValues, {
      fromParts: pairs.fromParts,
      fromLabels: pairs.fromLabels,
      toLabels: pairs.toLabels,
      ...acceptApplyOpts(
        report?.left_on ?? [],
        keyIndex,
        compositeMode,
        compositeFuzzySlot,
      ),
    });
  }

  const leftoverCount =
    (report?.leftover_left.length ?? 0) + (report?.leftover_right.length ?? 0);

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <section
        className="flex min-h-0 flex-1 flex-col"
        aria-label="Fuzzy match confirm"
      >
        <div className="flex shrink-0 flex-col gap-1 border-b border-amber-950/40 bg-amber-950/20 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-100">
              Quick match
            </span>
            <span className="text-[10px] text-slate-400">
              {loading
                ? "Scoring unmatched keys…"
                : report?.disabled_reason
                  ? report.disabled_reason
                  : report
                    ? `${accepted.length} ready · ${pending.length} need a click · min ${report.score_cutoff}`
                    : "—"}
            </span>
          </div>
          {!loading && !report?.disabled_reason && proposals.length > 0 && (
            <p className="text-[11px] leading-snug text-amber-100/90">
              {pending.length > 0 ? (
                <>
                  Yellow → <span className="font-semibold">Best</span> /{" "}
                  <span className="font-semibold">Skip</span>
                  {" · "}
                  then one{" "}
                  <span className="font-semibold">Write Mapping</span> for the
                  whole batch (fuzzy + LLM)
                </>
              ) : (
                <>
                  Batch ready — optional: add LLM leftovers into{" "}
                  <span className="font-semibold">this same list</span>, then
                  one <span className="font-semibold">Write Mapping</span>
                </>
              )}
            </p>
          )}
          {report && report.left_on.length > 1 && (
            <div className="flex flex-wrap gap-1">
              <span className="w-full text-[9px] text-slate-500">
                Next step — pick how to suggest (required for multi-key Join):
              </span>
              <button
                type="button"
                onClick={() => {
                  setCompositeMode(false);
                  setKeyIndex(null);
                }}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  !compositeMode && keyIndex == null
                    ? "border-amber-500/60 bg-amber-500/15 text-amber-50"
                    : "border-slate-700 text-slate-400"
                }`}
              >
                Pick column…
              </button>
              {report.left_on.map((col, i) => (
                <button
                  key={col}
                  type="button"
                  onClick={() => {
                    setCompositeMode(false);
                    setKeyIndex(i);
                  }}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                    !compositeMode && keyIndex === i
                      ? "border-amber-500/60 bg-amber-500/15 text-amber-50"
                      : "border-slate-700 text-slate-400"
                  }`}
                >
                  {col}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setKeyIndex(null);
                  setCompositeMode(true);
                  setCompositeFuzzySlot(0);
                }}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  compositeMode
                    ? "border-teal-500/60 bg-teal-500/15 text-teal-50"
                    : "border-slate-700 text-slate-400"
                }`}
              >
                Composite From
              </button>
              {compositeMode &&
                report.left_on.map((col, i) => (
                  <button
                    key={`fuzzy-${col}`}
                    type="button"
                    onClick={() => setCompositeFuzzySlot(i)}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      compositeFuzzySlot === i
                        ? "border-teal-500/60 bg-teal-500/15 text-teal-50"
                        : "border-slate-700 text-slate-400"
                    }`}
                    title="Which From part is scored by fuzzy"
                  >
                    fuzzy:{col}
                  </button>
                ))}
            </div>
          )}
        </div>

        {error && (
          <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-200">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {report &&
            proposals.length === 0 &&
            !loading && (
              <div className="space-y-1.5 border-b border-slate-800 px-2 py-2 text-[10px] text-slate-400">
                <p>
                  No fuzzy pairs above the cutoff. Use the LLM chat below for
                  leftovers, or{" "}
                  <span className="font-semibold text-teal-200/90">No match</span>{" "}
                  for one-by-one fixes.
                </p>
                {report.left_on.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setKeyIndex(null);
                      setCompositeMode(false);
                    }}
                    className="rounded border border-amber-800/70 px-2 py-1 text-[11px] text-amber-100 hover:border-amber-500"
                  >
                    ← Change which join key to suggest
                  </button>
                )}
              </div>
            )}
          {proposals.map((p) => (
            <div
              key={p.id}
              data-testid={`lens-confirm-${p.decision}`}
              className={`border-b border-slate-800/70 px-2 py-1.5 text-[11px] ${
                p.decision === "accepted"
                  ? "bg-teal-950/20"
                  : p.decision === "skipped"
                    ? "bg-slate-950/40 opacity-60"
                    : "bg-amber-950/15"
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-amber-50">
                    {p.from_key}
                    {p.from_label ? (
                      <span className="font-sans text-slate-400">
                        {" "}
                        · {p.from_label}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-mono text-teal-100/90">
                    → {p.to_key}
                    {p.to_label ? (
                      <span className="font-sans text-slate-400">
                        {" "}
                        · {p.to_label}
                      </span>
                    ) : null}
                    {p.alt_to_key && p.decision === "pending"
                      ? ` · or ${p.alt_to_key}`
                      : ""}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {p.source}
                    {p.source === "fuzzy"
                      ? ` · ${p.score.toFixed(3)} · edits ${p.edits}`
                      : ""}
                    {p.from_label || p.to_label ? " · by name" : ""}
                    {p.ambiguous ? " · ambiguous" : ""}
                    {p.decision === "accepted" ? " · accepted" : ""}
                    {p.decision === "skipped" ? " · skipped" : ""}
                    {p.decision === "pending" ? " · confirm" : ""}
                    {p.why ? ` · ${p.why}` : ""}
                  </span>
                </span>
                <div className="flex shrink-0 flex-col gap-0.5">
                  {p.decision === "pending" && (
                    <>
                      <button
                        type="button"
                        data-testid="lens-confirm-best"
                        onClick={() =>
                          setProposals((prev) =>
                            patchProposal(prev, p.id, acceptProposal(p)),
                          )
                        }
                        className="rounded border border-teal-700/70 px-1.5 py-0.5 text-[9px] text-teal-100 hover:bg-teal-500/15"
                      >
                        Best
                      </button>
                      {p.alt_to_key && (
                        <button
                          type="button"
                          data-testid="lens-confirm-alt"
                          onClick={() =>
                            setProposals((prev) =>
                              patchProposal(
                                prev,
                                p.id,
                                acceptProposal(p, p.alt_to_key!),
                              ),
                            )
                          }
                          className="rounded border border-amber-800/70 px-1.5 py-0.5 text-[9px] text-amber-100 hover:bg-amber-500/10"
                          title={p.alt_to_key}
                        >
                          Alt
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="lens-confirm-skip"
                        onClick={() =>
                          setProposals((prev) =>
                            patchProposal(prev, p.id, skipProposal(p)),
                          )
                        }
                        className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
                      >
                        Skip
                      </button>
                    </>
                  )}
                  {p.decision === "accepted" && (
                    <button
                      type="button"
                      onClick={() =>
                        setProposals((prev) =>
                          patchProposal(prev, p.id, skipProposal(p)),
                        )
                      }
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
                    >
                      Skip
                    </button>
                  )}
                  {p.decision === "skipped" && (
                    <button
                      type="button"
                      onClick={() =>
                        setProposals((prev) =>
                          patchProposal(prev, p.id, reopenProposal(p)),
                        )
                      }
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
                    >
                      Undo
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

      </section>

      {/* Stay above the LLM sheet so Write is never covered. */}
      <div
        className={`flex shrink-0 flex-wrap items-center gap-2 border-t border-amber-900/40 bg-amber-950/25 px-2 py-2 ${
          chatOpen ? "relative z-30 shadow-[0_-8px_24px_rgba(0,0,0,0.35)]" : ""
        }`}
        style={chatOpen ? { marginBottom: llmHeightPx } : undefined}
      >
        <button
          type="button"
          data-testid="lens-apply-accepted"
          disabled={!onAccept || accepted.length === 0}
          onClick={commitAccepted}
          className="rounded border-2 border-amber-500 bg-amber-500/35 px-3 py-2 text-[13px] font-bold text-amber-50 shadow-[0_0_0_1px_rgba(245,158,11,0.25)] disabled:opacity-40"
          title="Writes Mapping + Apply. LLM queue is not a write."
        >
          Write Mapping · {accepted.length} pair
          {accepted.length === 1 ? "" : "s"}
          {pending.length > 0 ? " (yellow skipped)" : ""}
        </button>
        <span className="max-w-[14rem] text-[10px] leading-snug text-amber-100/85">
          {pending.length > 0
            ? "Yellow stay out until Best / Skip."
            : leftoverCount > 0
              ? "Can still pull LLM leftovers into this batch before Write."
              : "Writes Mapping + Apply for every accepted row."}
        </span>
        {!chatOpen && leftoverCount > 0 && (
          <button
            type="button"
            onClick={() => openLlmLeftovers()}
            className="ml-auto rounded border border-teal-800/70 px-2 py-1 text-[10px] text-teal-200/90 hover:border-teal-600 hover:text-teal-50"
          >
            Add LLM leftovers · {leftoverCount} ▾
          </button>
        )}
      </div>

      {chatOpen && report && (
        <section
          ref={chatPanelRef}
          className={`absolute inset-x-0 bottom-0 z-20 flex flex-col border-t border-teal-400/80 bg-[#06141c] shadow-[0_-12px_40px_rgba(0,0,0,0.45)] ${
            chatReveal ? "lens-llm-enter" : ""
          }`}
          style={{ height: llmHeightPx }}
          aria-label="LLM chat for leftovers"
          aria-live="polite"
        >
          <PanelResizeHandle
            orientation="horizontal"
            onDelta={onLlmResizeDelta}
            aria-label="Resize LLM panel"
            title="Drag to resize LLM height"
          />
          <div className="flex shrink-0 items-center gap-1.5 border-b border-teal-500/40 bg-teal-500/15 px-2 py-1 text-[10px] text-teal-50">
            <span className="font-semibold tracking-wide">▴ LLM</span>
            <span className="text-teal-200/50">·</span>
            <span>
              drag top edge to resize · ask → Add to batch →{" "}
              <span className="font-semibold text-amber-100">
                Write Mapping
              </span>
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-teal-950/60 bg-teal-950/30 px-2 py-1.5">
            <span className="rounded bg-teal-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-teal-200/95">
              LLM chat
            </span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-slate-400">
              Same batch as fuzzy above
              {leftoverCount ? ` · ${leftoverCount} leftover keys` : ""}
            </span>
            <button
              type="button"
              onClick={() => setShowConn((v) => !v)}
              className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:text-slate-200"
            >
              {baseUrl.trim() && model.trim()
                ? model.trim() || llm?.model || "LLM"
                : "Connect LLM"}
            </button>
            <button
              type="button"
              onClick={() => {
                setChatReveal(false);
                setChatOpen(false);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-slate-600/80 bg-slate-950/90 text-[14px] leading-none text-slate-300 hover:border-slate-400 hover:text-white"
              title="Hide LLM panel"
              aria-label="Hide LLM panel"
            >
              ×
            </button>
          </div>

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

          <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-2 py-1.5">
            {chat.length === 0 && (
              <div className="text-[10px] leading-relaxed text-slate-500">
                {report.leftover_left.length + report.leftover_right.length === 0
                  ? "No leftover keys. Fuzzy covered the unmatched sample, or both sides already match."
                  : `${report.leftover_left.length} left and ${report.leftover_right.length} right keys have no fuzzy pair. Ask the model; queue pairs into Auto, then confirm there.`}
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
            <div className="rounded border border-teal-900/60 bg-teal-950/40 px-2 py-1.5 text-[10px] leading-snug text-teal-100/90">
              Fuzzy + LLM share one list. Add model pairs into that batch,
              then one{" "}
              <span className="font-semibold">Write Mapping</span> on the bar
              above.
            </div>
            {chatPairs.length > 0 && (
              <div className="rounded border border-teal-800/70 bg-teal-950/25 p-1.5">
                <div className="mb-1 text-[9px] uppercase tracking-wide text-teal-200/80">
                  Model pairs → same Auto batch
                </div>
                {chatPairs.map((p) => (
                  <div key={`${p.from}→${p.to}`} className="mb-1 last:mb-0">
                    <div className="truncate font-mono text-[10px] text-teal-50">
                      {p.from} → {p.to}
                    </div>
                    {p.why && (
                      <div className="text-[10px] leading-snug text-slate-400">
                        {p.why}
                      </div>
                    )}
                  </div>
                ))}
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    data-testid="lens-queue-llm"
                    onClick={() => queueLlmPairs("accepted")}
                    className="rounded border border-teal-500/80 bg-teal-500/20 px-2 py-0.5 text-[10px] font-semibold text-teal-50"
                    title="Add as accepted into the list above; then Write Mapping once for fuzzy + these"
                  >
                    Add to batch ({chatPairs.length})
                  </button>
                  <button
                    type="button"
                    data-testid="lens-queue-llm-review"
                    onClick={() => queueLlmPairs("pending")}
                    className="rounded border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:text-slate-100"
                    title="Add as yellow — Best / Skip before Write includes them"
                  >
                    Add as yellow
                  </button>
                </div>
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
