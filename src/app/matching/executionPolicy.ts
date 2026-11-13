/** PR-00B / ADR-0047: sample data is never authority to write a user's map. */
import { FIXTURE_PLAN } from "./fixtures";
import { emptyMatchingSession, newMatchingSessionId, type MatchingTabSession } from "./types";

export const LIVE_TRIAL_UNAVAILABLE =
  "Live matching unavailable: confirmed source and target rows are not connected to this trial yet. No query results have been retrieved. Use Demo fixtures for sample data only.";

export function matchingWriteRefusal(session: MatchingTabSession): string | null {
  if (session.executionMode === "demo" || session.proposals.some((p) => p.provenance === "fixture")) {
    return "Demo fixtures cannot be written to a Mapping. These are sample results, not live query results.";
  }
  return null;
}

/** Construct from scratch, never carry a live target, draft, baseline or Lens. */
export function createMatchingDemoSession(): MatchingTabSession {
  return {
    ...emptyMatchingSession({
      id: newMatchingSessionId(), title: "Matching: Demo fixtures", entry: "query",
      scope: "cohort", instructionText: "", plan: structuredClone(FIXTURE_PLAN),
      hasUnsavedDecisions: false, chatCollapsed: true,
    }),
    executionMode: "demo",
  };
}
