import { useEffect, useRef, useState } from "react";
import type { ConnectionDef, Workspace } from "../types/pipeline";
import {
  keyMapFuzzySuggest,
  type FuzzyPair,
  type KeyMapFuzzySuggest,
  type KeyMapMatchSource,
} from "../lib/bridge";

type Props = {
  workspace: Workspace;
  connections: ConnectionDef[];
  onAccept: (suggestions: FuzzyPair[]) => void;
};

const emptySource = (): KeyMapMatchSource => ({
  query_id: "", key_column: "", label_column: "",
});

/** Read-only proposals. Acceptance edits the existing KeyMap draft. */
export function KeyMapFuzzyPanel({ workspace, connections, onAccept }: Props) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(emptySource);
  const [right, setRight] = useState(emptySource);
  const [cutoff, setCutoff] = useState("0.88");
  const [gap, setGap] = useState("0.03");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KeyMapFuzzySuggest | null>(null);
  const revision = useRef(0);

  // A response for an earlier workspace must never become an acceptable result.
  useEffect(() => {
    revision.current++;
    setResult(null);
    return () => { revision.current++; };
  }, [workspace, connections]);

  function invalidate() {
    revision.current++;
    setResult(null);
    setError(null);
  }

  async function run() {
    const token = ++revision.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await keyMapFuzzySuggest(workspace, connections, left, right, {
        score_cutoff: Number(cutoff), ambiguity_gap: Number(gap),
      });
      if (token === revision.current) setResult(response);
    } catch (e) {
      if (token === revision.current) setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const validSource = (source: KeyMapMatchSource) =>
    workspace.queries.some((q) => q.id === source.query_id) && source.key_column.trim();
  const validOption = (value: string) =>
    value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;

  return <div className="shrink-0 border-b border-slate-800 px-4 py-2 text-xs">
    <button className="text-teal-300" onClick={() => setOpen(!open)}>
      Fuzzy suggestions · compare keys or labels
    </button>
    {open && <div className="mt-2 space-y-2">
      <p className="text-slate-400">
        Choose two dictionary queries. Compare labels, return codes. Leave label empty to compare keys.
        Up to 250,000 unique, trimmed keys per side; key/label length ≤512 characters.
        Candidate search is bounded; some matches may be missed. Existing filled mappings are kept.
      </p>
      {[{ title: "From", source: left, setSource: setLeft },
        { title: "To", source: right, setSource: setRight }].map(({ title, source, setSource }) =>
        <div key={title} className="flex flex-wrap items-center gap-2">
          <span className="w-12 text-slate-400">{title}</span>
          <select aria-label={`${title} query`} disabled={busy} value={source.query_id}
            onChange={(e) => { invalidate(); setSource({ ...emptySource(), query_id: e.target.value }); }}
            className="bg-slate-900 p-1">
            <option value="">Choose query</option>
            {workspace.queries.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
          </select>
          <input aria-label={`${title} key column`} placeholder="Key column" disabled={busy}
            value={source.key_column} onChange={(e) => {
              invalidate(); setSource({ ...source, key_column: e.target.value });
            }} className="w-36 bg-slate-900 p-1" />
          <input aria-label={`${title} label column`} placeholder="Label column (optional)" disabled={busy}
            value={source.label_column ?? ""} onChange={(e) => {
              invalidate(); setSource({ ...source, label_column: e.target.value });
            }} className="w-44 bg-slate-900 p-1" />
        </div>)}
      <div className="flex items-center gap-2">
        <label>Score cutoff <input aria-label="Score cutoff" type="number" min="0" max="1" step="0.01"
          value={cutoff} disabled={busy} onChange={(e) => { invalidate(); setCutoff(e.target.value); }}
          className="w-20 bg-slate-900 p-1" /></label>
        <label>Ambiguity gap <input aria-label="Ambiguity gap" type="number" min="0" max="1" step="0.01"
          value={gap} disabled={busy} onChange={(e) => { invalidate(); setGap(e.target.value); }}
          className="w-20 bg-slate-900 p-1" /></label>
        <button disabled={busy || !validSource(left) || !validSource(right) || !validOption(cutoff) || !validOption(gap)}
          onClick={() => void run()} className="rounded border border-teal-700 px-2 py-1 disabled:opacity-40">
          {busy ? "Matching…" : "Suggest mappings"}
        </button>
      </div>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {result && <div className="space-y-1">
        <p>{result.left_rows.toLocaleString()} From · {result.right_rows.toLocaleString()} To · {result.suggestions.length.toLocaleString()} proposals · {result.ambiguous.toLocaleString()} ambiguous · {result.unmatched.toLocaleString()} without proposal · {result.seconds.toFixed(1)}s</p>
        <p className="text-slate-500">Sample: {result.suggestions.slice(0, 5).map((p) =>
          `${p.from_key} → ${p.to_key} (${p.score.toFixed(3)}${p.ambiguous ? `; alternative ${p.alt_to_key}` : ""})`).join("; ")}</p>
        <button onClick={() => { onAccept(result.suggestions); setResult(null); }}
          className="rounded border border-teal-700 px-2 py-1 text-teal-200">
          Accept unambiguous proposals into draft
        </button>
        <p className="text-slate-500">Use the existing Save map action to persist your changes.</p>
      </div>}
    </div>}
  </div>;
}
