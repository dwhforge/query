export {
  applyMappingCreateOntoProject,
  buildFieldsPatch,
  buildMappingCreatePlan,
  directQueryConsumers,
  excludedByLastFields,
  isLocalQueryId,
  listLocalQueries,
  makeSchemaEvidence,
  probeLastFieldsRestore,
  validateDraftSelection,
  validateMappingCreatePlan,
} from "./service";
export type {
  MappingCreateApplyIntent,
  MappingCreateApplyResult,
  MappingCreateDraft,
  MappingCreatePlan,
  QueryFieldsPatch,
  SchemaEvidence,
} from "./types";
