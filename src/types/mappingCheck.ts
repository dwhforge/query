/** Durable mapping quality check IR (ADR-0027). */

export type CheckComparability =
  | { kind: "full" }
  | { kind: "limited"; reason: string };

export type CheckDeltaAttribution =
  | "mapping_changed"
  | "inputs_changed"
  | "both_changed"
  | "definition_changed"
  | "unchanged"
  | "limited";

export type MappingAllowDecision = {
  id: string;
  group_key: string;
  explanation: string;
  created_at: string;
};

export type MappingCheckProjection =
  | { kind: "lab_v1" }
  | {
      kind: "attrs";
      host_query_id: string;
      left_attr: string;
      right_attr: string;
      sample_column: string;
    };

export type MappingCheck = {
  id: string;
  name: string;
  map_id: string;
  input_refs: string[];
  group_attributes: string[];
  cohort_predicate: string;
  projection: MappingCheckProjection;
  allow_decisions: MappingAllowDecision[];
};

export type CheckInputRevision = {
  ref_id: string;
  revision: string | null;
  unknown_reason?: string;
};

export type CheckAggregateCell = {
  row: string;
  column: string;
  signal: string;
  positions: number;
  revenue: number;
  samples: string[];
};

export type CheckRun = {
  id: string;
  check_id: string;
  ran_at: string;
  map_revision: string;
  input_revisions: CheckInputRevision[];
  check_definition_revision: string;
  total_positions: number;
  cells: CheckAggregateCell[];
  comparability: CheckComparability;
};

export type FrozenRemapPreview = {
  check_id: string;
  map_id: string;
  expected_map_revision: string;
  /** Snapshotted at preview — confirm refuses if inputs moved (ADR-0027). */
  expected_input_revisions: CheckInputRevision[];
  changes: { from: string; to: string }[];
  previewed_at: string;
};
