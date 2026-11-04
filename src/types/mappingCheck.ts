/** Durable mapping quality check IR (ADR-0027 / ADR-0029).
 *
 * Wire shapes are generated from Rust — see `./generated`.
 * UI-only session freeze stays hand-written until promoted.
 */

export type {
  CheckAggregateCell,
  CheckComparability,
  CheckDeltaAttribution,
  CheckInputRevision,
  CheckRun,
  MappingAllowDecision,
  MappingCheck,
  MappingCheckProjection,
} from "./generated";

/** Preview payload held in UI until confirm (not persisted on Project). */
export type FrozenRemapPreview = {
  check_id: string;
  map_id: string;
  expected_map_revision: string;
  /** Snapshotted at preview — confirm refuses if inputs moved (ADR-0027). */
  expected_input_revisions: import("./generated").CheckInputRevision[];
  changes: { from: string; to: string }[];
  previewed_at: string;
};
