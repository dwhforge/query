# Matching: Evaluate, Estimate and relationship-set semantics (work-in-progress)

This is a generic DWHQuery capability. The Help Lab may demonstrate it, but cannot
be a dependency of the engine, runtime or UI. `Matching` is the product name.

## Non-negotiable boundaries

* **Evaluate** operates on the entire explicitly requested source/target scope,
  or refuses to return a completed result. UI pages, table previews and displayed
  candidate shortlists are NEVER an evaluation input scope.
* **Estimate** is optional and may use a sampled source population. The sample
  percentage is explicit and configurable (default **5%**, valid **1–100%**).
  Neither its counts nor extrapolations can be labelled completed matching,
  confirmed matches, JOIN impact or complete source coverage.
* A complete source set is not the same as an exhaustive pair search. Distinguish
  `source coverage`, `target coverage`, `candidate generation policy`, `scored
  competitors` and `displayed shortlist` as separate facts.
* No operation called `Estimate` or `Evaluate` modifies Mapping, Join, project
  file, session decisions, or commit/write authority.
* A scoring result is not a verified join output. Actual JOIN row counts and
  fan-out require a separately verified what-if execution.
* A/B comparisons are only indicative unless both runs share a verified stable
  data snapshot. Matching definitions/identical key sets alone are insufficient.

## First integrated single-workspace slice

* `Matching` has **one main result surface** for acquired Basic/Advanced evidence:
  a relationship-set table, coverage statistics, result filters and bulk selection.
  The legacy LEFT/RIGHT explorer and its inspector remain in source for rollback
  during migration, not as a user-facing navigation destination after acquisition.
* Rules continue to use the existing top-of-workspace plan editor and its
  semantic-invalidation / live-acquisition authority. A Rules edit never
  silently confirms a pair or writes Mapping.
* Row **Details** and **Review** are contextual overlay panels on the same
  results surface. Details offers only source-bound acquired alternatives;
  verified manual lookup and advanced exceptional actions are migration gaps.
* Existing `applyDecision`, validated bulk logic and `onCommit` retain authority.
  **Write** is an explicit action, never a consequence of Estimate/Evaluate.
* The `Estimate` sample percentage (default 5%) is demonstrative sampling of
  *already acquired* evaluation rows; it is **not** a source preflight estimator.
* The new universal Evaluation types do not depend on JOIN, Mapping, or Help Lab;
  however the first production adapter is **still JOIN-bound** and capped.

## Not implemented: required before production default

1. A provider-independent `MatchingInput` that binds arbitrary LEFT and RIGHT
   datasets (not only an original JOIN). Explicit projection of key fields,
   comparison fields, target identity fields and desired outputs.
2. Source-side `matching_estimate(request)` preflight RPC with `samplePercent`,
   scope identity, sample provenance, total-row-count knowledge and coverage
   metadata. Sampling must occur against the declared dataset, never a UI page.
3. SQL-backed full-scope evaluation; candidate generation and scoring streaming
   or server-side. On any cap, cancellation, timeout or changing source version,
   report refusal/incomplete and never an apparently complete result.
4. Content-addressed or snapshot-bound versions for honest A/B; current
   context fingerprints do not prove the underlying database is unchanged.
5. A separate verified JOIN what-if contract. Never simulate via write + undo.
6. Existing Basic/Advanced/Electron regression suite, accessibility and live
   screenshot acceptance before turning the new view into the default.

## Required end-to-end tests

* >20 source groups and >10,000 targets: no silent truncation or fake `COMPLETE`.
* Full input of 100k LEFT records with UI page size 50: summary covers 100k.
* Candidate blocking excludes some comparisons: report policy/unknown recall.
* Partial or unknown source acquisition: no `0 not acquired` claim.
* A/B sources mutate between executions: compare downgraded/blocked.
* Set Evaluate with Estimate samplePercent changed 5→20: Evaluation pairs
  and full-scope counters stay exactly unchanged.
* No automatic user decisions and no Mapping write from either operation.
