import { useEffect, useMemo, useState } from "react";
import type { ConnectionDef, SourceDef, Workspace } from "../types/pipeline";
import {
  getLlmConfig,
  joinKeyFuzzySuggest,
  llmChat,
  type FuzzyPair,
  type JoinKeyFuzzySuggest,
  type LlmConfig,
} from "../lib/bridge";
import {
  joinKeyMapFocusUserMessage,
  joinKeyMapSystemPrompt,
  parseSuggestedPairs,
} from "../lib/joinLensLlmPrompt";

type Candidate = {
  to: string;
  source: "fuzzy" | "llm" | "manual";
  score?: number;
  why?: string;
  ambiguous?: boolean;
};

function rightUniverse(report: JoinKeyFuzzySuggest): Set<string> {
  return new Set([
    ...(report.chat_context.right_to_universe ?? []),
    ...report.leftover_right,
  ]);
}

async function runLlm(
  report: JoinKeyFuzzySuggest,
  fromKey: string,
  sinks: {
    cancelled: () => boolean;
    setBusy: (v: boolean) => void;
    setError: (v: string | null) => void;
    setNote: (v: string | null) => void;
    setCandidates: (v: Candidate[]) => void;
    setPickedIfEmpty: (to: string) => void;
  },
) {
  sinks.setBusy(true);
  sinks.setError(null);
  sinks.setNote(null);
  try {
    const res = await llmChat([
      {
        role: "system",
        content: joinKeyMapSystemPrompt(report, { focusFrom: fromKey }),
      },
      {
        role: "user",
        content: joinKeyMapFocusUserMessage(fromKey),
      },
    ]);
    if (sinks.cancelled()) return;
    sinks.setNote(res.content);
    const allowed = rightUniverse(report);
    const pairs = parseSuggestedPairs(res.content).filter(
      (p) => p.from === fromKey && allowed.has(p.to),
    );
    sinks.setCandidates(
      pairs.map((p) => ({
        to: p.to,
        source: "llm" as const,
        why: p.why,
      })),
    );
    if (pairs[0]) sinks.setPickedIfEmpty(pairs[0].to);
  } catch (e) {
    if (!sinks.cancelled()) {
      sinks.setError(typeof e === "string" ? e : String(e));
    }
  } finally {
    if (!sinks.cancelled()) sinks.setBusy(false);
  }
}

export function FindRightDialog({
  open,
  fromKey,
  workspace,
  hostQueryId,
  joinStepIndex,
  connections,
  sources = [],
  onClose,
  onAccept,
}: {
  open: boolean;
  fromKey: string;
  workspace: Workspace;
  hostQueryId: string;
  joinStepIndex: number;
  connections: ConnectionDef[];
  sources?: SourceDef[];
  onClose: () => void;
  onAccept: (from: string, to: string) => void;
}) {
  const [report, setReport] = useState<JoinKeyFuzzySuggest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmNote, setLlmNote] = useState<string | null>(null);
  const [llmCandidates, setLlmCandidates] = useState<Candidate[]>([]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getLlmConfig()
      .then((cfg) => {
        if (!cancelled) setLlm(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !fromKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    setPicked(null);
    setFilter("");
    setLlmCandidates([]);
    setLlmNote(null);
    setLlmError(null);
    setLlmBusy(false);

    async function run() {
      try {
        const r = await joinKeyFuzzySuggest(
          workspace,
          hostQueryId,
          joinStepIndex,
          connections,
          sources,
        );
        if (cancelled) return;
        setReport(r);
        const forKey = r.suggestions.filter((p) => p.from_key === fromKey);
        const hit = forKey.find((p) => !p.ambiguous);
        if (hit) setPicked(hit.to_key);
        setLoading(false);

        // No fuzzy hit → fall through to LLM immediately.
        if (!r.disabled_reason && forKey.length === 0) {
          await runLlm(r, fromKey, {
            cancelled: () => cancelled,
            setBusy: setLlmBusy,
            setError: setLlmError,
            setNote: setLlmNote,
            setCandidates: setLlmCandidates,
            setPickedIfEmpty: (to) => {
              setPicked((prev) => prev ?? to);
            },
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(typeof e === "string" ? e : String(e));
          setLoading(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, fromKey, workspace, hostQueryId, joinStepIndex, connections, sources]);

  const fuzzyPairs: FuzzyPair[] = useMemo(() => {
    if (!report) return [];
    return report.suggestions.filter((p) => p.from_key === fromKey);
  }, [report, fromKey]);

  const fuzzyCandidates: Candidate[] = useMemo(() => {
    const out: Candidate[] = [];
    for (const p of fuzzyPairs) {
      out.push({
        to: p.to_key,
        source: "fuzzy",
        score: p.score,
        ambiguous: p.ambiguous,
      });
      if (p.alt_to_key) {
        out.push({
          to: p.alt_to_key,
          source: "fuzzy",
          score: p.alt_score ?? undefined,
          ambiguous: true,
          why: "alternate",
        });
      }
    }
    return out;
  }, [fuzzyPairs]);

  const universe = useMemo(() => {
    if (!report) return [] as string[];
    const set = new Set<string>([
      ...(report.chat_context.right_to_universe ?? []),
      ...report.leftover_right,
    ]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [report]);

  const filteredUniverse = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return universe.slice(0, 40);
    return universe.filter((k) => k.toLowerCase().includes(q)).slice(0, 40);
  }, [universe, filter]);

  const allCandidates = useMemo(() => {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of [...fuzzyCandidates, ...llmCandidates]) {
      if (seen.has(c.to)) continue;
      seen.add(c.to);
      out.push(c);
    }
    return out;
  }, [fuzzyCandidates, llmCandidates]);

  async function askLlm() {
    if (!report || llmBusy || report.disabled_reason) return;
    await runLlm(report, fromKey, {
      cancelled: () => false,
      setBusy: setLlmBusy,
      setError: setLlmError,
      setNote: setLlmNote,
      setCandidates: setLlmCandidates,
      setPickedIfEmpty: (to) => {
        setPicked((prev) => prev ?? to);
      },
    });
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="find-right-title"
        className="flex max-h-[min(90vh,36rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0a1219] shadow-2xl shadow-black/50"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            <h2
              id="find-right-title"
              className="text-sm font-semibold text-teal-100"
            >
              Suggest Right
            </h2>
            <p className="mt-1 truncate font-mono text-xs text-amber-100/90">
              From: {fromKey}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-500">
              Fuzzy first; if nothing matches, LLM runs automatically
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {loading && (
            <p className="text-[11px] text-slate-500">Scoring unmatched keys…</p>
          )}
          {error && (
            <p className="text-[11px] text-rose-300/90">{error}</p>
          )}
          {report?.disabled_reason && (
            <p className="rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-100/90">
              {report.disabled_reason}
            </p>
          )}

          {!loading && report && !report.disabled_reason && (
            <>
              <section>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Suggestions
                  </h3>
                  <button
                    type="button"
                    disabled={llmBusy}
                    onClick={() => void askLlm()}
                    className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-300 hover:border-teal-800 hover:text-teal-200 disabled:opacity-40"
                    title={
                      llm
                        ? `Ask ${llm.model}`
                        : "Configure LLM in Auto tab if needed"
                    }
                  >
                    {llmBusy ? "Asking LLM…" : "Ask LLM"}
                  </button>
                </div>
                {allCandidates.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    {llmBusy
                      ? "No fuzzy hit — asking LLM…"
                      : llmError
                        ? "No fuzzy hit; LLM failed. Pick from the right universe below, or retry Ask LLM."
                        : `No fuzzy hit above cutoff${
                            report.score_cutoff
                              ? ` (${report.metric} ≥ ${report.score_cutoff})`
                              : ""
                          }. Pick from the right universe below, or Ask LLM.`}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {allCandidates.map((c) => {
                      const selected = picked === c.to;
                      return (
                        <li key={`${c.source}:${c.to}`}>
                          <button
                            type="button"
                            onClick={() => setPicked(c.to)}
                            className={`flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-[11px] ${
                              selected
                                ? "border-teal-600/80 bg-teal-500/15 text-teal-50"
                                : "border-slate-800 bg-slate-950/60 text-slate-300 hover:border-slate-600"
                            }`}
                          >
                            <span className="mt-0.5 shrink-0 text-[9px] uppercase text-slate-500">
                              {c.source}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-amber-50">
                                {c.to}
                              </span>
                              <span className="text-[9px] text-slate-500">
                                {c.score != null &&
                                  `jaro ${c.score.toFixed(3)}`}
                                {c.ambiguous ? " · ambiguous" : ""}
                                {c.why ? ` · ${c.why}` : ""}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {llmError && (
                  <p className="mt-1 text-[10px] text-rose-300/90">{llmError}</p>
                )}
                {llmNote && (
                  <details className="mt-2 rounded border border-slate-800 bg-slate-950/50 px-2 py-1 text-[10px] text-slate-400">
                    <summary className="cursor-pointer text-slate-500">
                      LLM rationale
                    </summary>
                    <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-sans">
                      {llmNote}
                    </pre>
                  </details>
                )}
              </section>

              <section>
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Right universe
                </h3>
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter right keys…"
                  className="mb-1.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:ring-1 focus:ring-teal-700"
                />
                <ul className="max-h-36 space-y-0.5 overflow-auto">
                  {filteredUniverse.map((k) => {
                    const selected = picked === k;
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          onClick={() => setPicked(k)}
                          className={`w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] ${
                            selected
                              ? "bg-teal-500/20 text-teal-100"
                              : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                          }`}
                        >
                          {k}
                        </button>
                      </li>
                    );
                  })}
                  {filteredUniverse.length === 0 && (
                    <li className="px-1 text-[10px] text-slate-600">
                      No keys match filter
                    </li>
                  )}
                </ul>
              </section>
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!picked}
            onClick={() => {
              if (!picked) return;
              onAccept(fromKey, picked);
              onClose();
            }}
            className="rounded border border-amber-600/80 bg-amber-500/25 px-3 py-1.5 text-[11px] font-semibold text-amber-50 hover:bg-amber-500/35 disabled:opacity-40"
          >
            Accept → KeyMap
          </button>
        </footer>
      </div>
    </div>
  );
}
