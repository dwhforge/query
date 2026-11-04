import type { KeyMapDirtyDelta } from "../../lib/bridge";
import type {
  KeyMapAuthoringContext,
  KeyMapDef,
  QueryDef,
  TransformationStep,
} from "../../types/pipeline";

/** Session-only wizard draft — never serialized into Project. */
export type MappingCreateDraft = {
  name: string;
  sourceQueryId: string;
  sourceColumns: string[];
  targetQueryId: string;
  targetColumn: string;
  /** Columns chosen for last-Fields restore, keyed by query id. */
  restoreColumnsByQuery: Record<string, string[]>;
};

export type SchemaEvidence = {
  queryId: string;
  /** Live output columns at review (describe). */
  outputColumns: string[];
  /** Columns immediately before last SelectColumns when last step is Fields. */
  upstreamColumns: string[] | null;
  digest: string;
};

export type QueryFieldsPatch = {
  queryId: string;
  /** Full SelectColumns list after append. */
  columns: string[];
  before: string[];
  after: string[];
};

export type MappingCreatePlan = {
  projectId: string;
  map: KeyMapDef;
  authoringContext: KeyMapAuthoringContext;
  /** Expected query step fingerprints at review time. */
  expectedQueryDefs: Record<string, string>;
  schemaEvidence: SchemaEvidence[];
  patches: QueryFieldsPatch[];
  consumers: Array<{ queryId: string; queryName: string; via: string }>;
  warnings: string[];
};

export type MappingCreateApplyIntent = {
  opId: string;
  plan: MappingCreatePlan;
};

export type MappingCreateApplyResult =
  | {
      status: "applied";
      opId: string;
      mapId: string;
      map: KeyMapDef;
      /** Empty — creation does not WH-save. */
      dirtyDelta: KeyMapDirtyDelta | null;
      message: string;
    }
  | { status: "stale"; opId: string; reason: string }
  | { status: "error"; opId: string; reason: string };

export type LastFieldsRestoreProbe = {
  query: QueryDef;
  upstreamColumns: string[];
  column: string;
};

export type LastFieldsRestoreResult =
  | { ok: true; column: string }
  | { ok: false; error: string };

export type StepFingerprint = string;

export function fingerprintSteps(steps: TransformationStep[]): StepFingerprint {
  return JSON.stringify(steps);
}

export function schemaDigest(columns: string[]): string {
  return columns.map((c) => c.trim()).filter(Boolean).join("\0");
}
