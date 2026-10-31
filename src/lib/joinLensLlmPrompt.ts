import type { JoinKeyFuzzySuggest } from "./bridge";

export type SuggestedPair = { from: string; to: string; why?: string };

/** Soft budget under host llm_chat per-message limit (12_000). */
const PROMPT_BUDGET = 10_500;

function takeLines(
  lines: string[],
  maxChars: number,
): { text: string; omitted: number } {
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

export function parseSuggestedPairs(text: string): SuggestedPair[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw =
    fence?.[1] ?? text.match(/\{[\s\S]*"pairs"\s*:[\s\S]*\}/)?.[0];
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

/**
 * Full Auto / Suggest LLM system prompt — lineage, schemas, aliases,
 * neighbor samples, right universe. Optional focusFrom prioritizes one key.
 */
export function joinKeyMapSystemPrompt(
  report: JoinKeyFuzzySuggest,
  opts?: { focusFrom?: string },
): string {
  const ctx = report.chat_context;
  const focusFrom = opts?.focusFrom?.trim() || "";
  const truncNotes: string[] = [];
  if (ctx.context_truncated || report.truncated) {
    truncNotes.push("Context lists were capped for size; prefer listed keys only.");
  }

  const head = [
    "You help map join keys inside DWHForge Query.",
    focusFrom
      ? `Primary task: propose To for this exact From only: ${JSON.stringify(focusFrom)}.`
      : "Fuzzy Jaro-Winkler already proposed close spellings; discuss leftover left keys that still need a To.",
    "Use join lineage, schemas, neighbor-field samples, KeyMap aliases, and fuzzy examples for domain (tickers, old names, codes).",
    "Old legal names, predecessor companies, and exchange tickers often map to a short right-side code (e.g. historical brewery name → ABEV).",
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

  if (focusFrom) {
    const focusSample = ctx.leftover_left_samples.find((s) => s.key === focusFrom);
    pushSection(
      `Focus From sample (${JSON.stringify(focusFrom)})`,
      focusSample
        ? fmtSamples([focusSample], 1)
        : [`- key=${JSON.stringify(focusFrom)} | (no neighbor sample in context)`],
      800,
    );
  }

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

  const leftoverLeft = focusFrom
    ? [
        focusFrom,
        ...report.leftover_left.filter((k) => k !== focusFrom),
      ].slice(0, 40)
    : report.leftover_left.slice(0, 40);
  pushSection(
    `Leftover left (From), ${report.leftover_left.length}`,
    leftoverLeft.map((k) => `- ${k}`),
    2000,
  );

  const leftSamples = focusFrom
    ? [
        ...ctx.leftover_left_samples.filter((s) => s.key === focusFrom),
        ...ctx.leftover_left_samples.filter((s) => s.key !== focusFrom),
      ]
    : ctx.leftover_left_samples;
  pushSection("Left leftover samples", fmtSamples(leftSamples, 10), 2200);

  const universe = (ctx.right_to_universe ?? []).slice(0, 60).map((k) => `- ${k}`);
  pushSection(
    `Right key universe (allowed To), ${(ctx.right_to_universe ?? []).length}`,
    universe,
    2200,
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

export function joinKeyMapFocusUserMessage(fromKey: string): string {
  return [
    `Suggest To for From=${JSON.stringify(fromKey)}.`,
    "Use neighbor fields, existing aliases, lineage, and domain knowledge (tickers, old company names → current codes).",
    "To must appear exactly in the right-key universe list.",
    "If a historical/legal name maps to a ticker already on the right (e.g. predecessor → ABEV), prefer that.",
  ].join(" ");
}
