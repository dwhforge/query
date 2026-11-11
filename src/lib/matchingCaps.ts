/**
 * Matching run caps (ADR-0044). SoT lives in
 * `crates/dwh-engine/src/matching/caps.rs` — keep these in sync or prefer
 * `matching_caps` host RPC at runtime.
 *
 * Alignment with HEAD fuzzy/LLM (join_fuzzy / key_map_fuzzy / llm.rs):
 * - massRunUniqueKeys 200 ≈ Join KEY_SCAN_CAP (unique keys in scope)
 * - retrievalShortlistPerKey 40 = Join MAX_SUGGESTIONS number, per-key unit
 * - llmCandidatesPerKey 10 < Join LLM universe list (60)
 * - localTargetUniverseRows 10_000 << dictionary MAX_SOURCE_ROWS (250_000)
 */
export const MATCHING_CAPS = {
  trialUniqueKeys: 20,
  massRunUniqueKeys: 200,
  retrievalShortlistPerKey: 40,
  llmCandidatesPerKey: 10,
  localTargetUniverseRows: 10_000,
  parallelLlmRequests: 2,
  llmRetriesPerRequest: 1,
  maxLlmCallsPerRun: 220,
} as const;
