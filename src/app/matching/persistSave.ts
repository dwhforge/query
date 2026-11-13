/** Existing Mapping persistence, followed (never preceded) by Matching acknowledgement. */
import type { KeyMapDirtyDelta, KeyMapSaveResult } from "../../lib/bridge";
import { fromColumnsEff, fromPartsEff, outputColumnsEff, outputValuesEff } from "../../lib/keyMap";
import type { KeyMapDef, KeyMapEntry } from "../../types/pipeline";
import { commitMatchingSession } from "./commitSave";
import { mapKeyToken, type MatchingTabSession } from "./types";

export type MatchingSaveResult =
  | { status: "saved" | "no_changes"; message: string; session: MatchingTabSession }
  | { status: "conflict" | "refused" | "error"; message: string; session?: MatchingTabSession };

export type MatchingSaveContext = {
  /** Project identity + persistence binding; must remain stable across awaits. */
  owner: string;
  map?: KeyMapDef;
  refusal?: string | null;
  externalSeed: boolean;
};

export type MatchingSaveDependencies = {
  context: () => MatchingSaveContext;
  isSessionCurrent: () => boolean;
  readSource: (map: KeyMapDef, keys: string[][]) => Promise<KeyMapEntry[]>;
  saveMap: (map: KeyMapDef, delta?: KeyMapDirtyDelta) => Promise<KeyMapSaveResult>;
  plan?: typeof commitMatchingSession;
};

/** Navigation/filter changes are allowed; decision/plan/evidence changes are not. */
export function matchingSaveRevision(session: MatchingTabSession): string {
  return JSON.stringify([
    session.id, session.targetMapId, session.generation, session.plan,
    session.proposals, session.candidates, session.decisions,
    session.explicitReplaceKeys, session.mapBaseline,
  ]);
}

export function classifyMatchingWrite(result: KeyMapSaveResult,
  storage?: { kind: string; externalSeed: boolean }):
  "saved" | "conflict" | "refused" | "error" {
  switch (result.external) {
    case "synced":
    case "none": return "saved";
    case "conflict": return "conflict";
    case "skipped": return storage?.kind === "seed" && !storage.externalSeed ? "saved" : "refused";
    case "error": return "error";
  }
}

function snapshot(entries: KeyMapEntry[]) {
  return entries.map((entry) => ({
    fromParts: fromPartsEff(entry), outputValues: outputValuesEff(entry),
  }));
}

/** Exact tuple upsert, not Lens fill-only merge (explicit replacement is meaningful). */
function mergeRows(map: KeyMapDef, upserts: ReturnType<typeof snapshot>): KeyMapDef {
  const rows = new Map(map.entries.map((e) => [mapKeyToken(fromPartsEff(e)), e]));
  for (const row of upserts) {
    const token = mapKeyToken(row.fromParts);
    rows.set(token, {
      ...rows.get(token), from: row.fromParts[0] ?? "", from_parts: row.fromParts,
      to: row.outputValues[0] ?? "", output_values: row.outputValues,
    });
  }
  return { ...map, entries: [...rows.values()] };
}

function sourceDelta(map: KeyMapDef, prior: KeyMapEntry[], next: KeyMapDef,
  upserts: ReturnType<typeof snapshot>): KeyMapDirtyDelta {
  const before = new Map(prior.map((e) => [mapKeyToken(fromPartsEff(e)), e]));
  const after = new Map(next.entries.map((e) => [mapKeyToken(fromPartsEff(e)), e]));
  return {
    deletedFroms: [],
    upserts: upserts.map((r) => after.get(mapKeyToken(r.fromParts))!),
    baselines: upserts.map((r) => {
      const entry = before.get(mapKeyToken(r.fromParts));
      return {
        fromParts: r.fromParts, existed: !!entry,
        to: entry ? outputValuesEff(entry)[0] ?? "" : "",
        outputs: Object.fromEntries(outputColumnsEff(map).map((c, i) =>
          [c, entry ? outputValuesEff(entry)[i] ?? "" : ""])),
        attrs: entry?.attrs ?? {},
      };
    }),
  };
}

export async function persistMatchingSession(
  session: MatchingTabSession, deps: MatchingSaveDependencies,
): Promise<MatchingSaveResult> {
  const refused = (message: string): MatchingSaveResult => ({ status: "refused", message });
  try {
    if (!session.targetMapId) return refused("Choose a target Mapping before saving.");
    const start = deps.context();
    const map = start.map;
    if (!map) return refused("Target Mapping not found.");
    if (start.refusal) return refused(start.refusal);
    const kind = map.storage?.kind ?? "seed";
    if (kind === "ref" || kind === "query" || map.time_mode === "range_scd") {
      return refused("This Mapping binding does not support Matching row writes. Open its authoring context instead.");
    }
    // Plan outputs name target fields; Mapping outputs may use different names.
    // Existing correspondence semantics bind their coherent tuple by position.
    if (!session.plan || fromColumnsEff(map).length !== session.plan.mapKeyFields.length ||
      outputColumnsEff(map).length !== session.plan.outputs.length) {
      return refused("Mapping key/output shape differs from the Matching plan. Refresh the plan.");
    }
    const mapRevision = JSON.stringify(map);
    const current = () => {
      const live = deps.context();
      return deps.isSessionCurrent() && live.owner === start.owner &&
        !live.refusal && JSON.stringify(live.map) === mapRevision;
    };
    if (!current()) return refused("Matching context changed. Retry with the current draft.");
    const keys = session.decisions
      .filter((d) => d.kind === "confirm_proposed" || d.kind === "choose_alternative")
      .map((d) => d.mapKey);
    const prior = kind === "source" && keys.length
      ? await deps.readSource(map, keys) : map.entries;
    if (!current()) return { status: "conflict", message: "Mapping or Matching context changed while reading. Retry." };
    for (const decision of session.decisions) {
      if (session.proposals.find((p) => p.proposalId === decision.proposalId)?.state !== "saved") continue;
      const candidate = session.candidates.find((c) => c.candidateId === decision.candidateId);
      const row = prior.find((e) => mapKeyToken(fromPartsEff(e)) === mapKeyToken(decision.mapKey));
      if (!candidate || !row || JSON.stringify(outputValuesEff(row)) !== JSON.stringify(candidate.outputValues)) {
        return { status: "conflict", message: "A previously saved row changed in the Mapping. Refresh before saving again." };
      }
    }
    const liveSession = { ...session, mapLive: snapshot(prior) };
    const planned = await (deps.plan ?? commitMatchingSession)(liveSession, { writeAllowed: true });
    if (!planned.ok) return { status: "conflict", message: `Save blocked: ${planned.reason}` };
    if (!current()) return { status: "conflict", message: "Mapping or Matching context changed while planning. Retry." };
    const nextMap = mergeRows({ ...map, entries: prior }, planned.upserts);
    let status: "saved" | "no_changes" = "no_changes";
    // Local AST already_matches is not proof that an exported seed was synced.
    // Always retry its existing write path, including after an earlier sync failure.
    if (planned.upserts.length || (kind === "seed" && start.externalSeed && keys.length)) {
      const result = await deps.saveMap(nextMap,
        kind === "source" ? sourceDelta(map, prior, nextMap, planned.upserts) : undefined);
      const outcome = classifyMatchingWrite(result, { kind, externalSeed: start.externalSeed });
      if (outcome !== "saved") {
        // Existing Save explicitly reports the local AST as written. Preserve the
        // confirmed draft, but baseline that local staging so an external retry
        // is not mistaken for an unrelated concurrent insert by the host gate.
        const staged = kind === "seed" && deps.isSessionCurrent() && deps.context().owner === start.owner;
        return {
          status: outcome, message: result.message,
          ...(staged ? { session: { ...session, mapBaseline: snapshot(nextMap.entries), mapLive: snapshot(nextMap.entries) } } : {}),
        };
      }
      status = "saved";
    }
    // No cancellation can undo a committed mutation. Only withhold stale UI acknowledgement.
    const end = deps.context();
    const endRevision = JSON.stringify(end.map);
    if (!deps.isSessionCurrent() || end.owner !== start.owner || end.refusal ||
      (endRevision !== mapRevision && endRevision !== JSON.stringify(nextMap))) {
      return { status: "conflict", message: "The save completed for an older context; current decisions remain unacknowledged. Refresh and retry." };
    }
    const accepted = new Set(planned.acceptedKeys.map(mapKeyToken));
    const proposals = session.proposals.map((p) =>
      accepted.has(mapKeyToken(p.mapKey)) &&
        (p.state === "confirmed_in_draft" || p.state === "saved")
        ? { ...p, state: "saved" as const } : p);
    const rows = snapshot(nextMap.entries);
    return {
      status,
      message: status === "saved"
        ? "Mapping save acknowledged. Save the project file separately to keep project changes."
        : "No changes: confirmed rows already match the current Mapping.",
      session: {
        ...session, proposals, mapLive: rows, mapBaseline: rows,
        hasUnsavedDecisions: proposals.some((p) => p.state === "confirmed_in_draft") ||
          session.decisions.some((d) => d.kind === "defer" || d.kind === "reject" || d.kind === "no_suitable_target"),
      },
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
