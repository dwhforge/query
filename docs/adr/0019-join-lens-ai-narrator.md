# ADR-0019 — Join Lens AI narrator (deferred)

## Status

**Deferred.** Deterministic Join Lens facts APIs ship first.

## Context

Join investigation needs answers to: how many / which rows a key produced, and why a key is missing (absent at source vs filtered upstream vs no partner). Industry tools (Tableau Prep, Alteryx L/J/R, joinwhy, Metabase Transform Inspector) answer these with **counts and samples**, not chat.

## Decision

1. **Facts first:** `explain_join_key` and `blame_unmatched_key` (plus existing `join_diagnostics` / `explain_join_rows`) are the source of truth.
2. **AI later (optional):** a narrator may turn a JSON report into prose. It must **not** invent counts, run arbitrary SQL, or replace the Lens UI.
3. Fuzzy join is **not** the core path (probabilistic matches break inspectable trust). Near-miss normalizations (trim/case/zeros) may come later as separate hypotheses.

## Consequences

- Ship explain + blame UI without an LLM dependency.
- When adding AI, pass only the structured report payload; display model text as commentary beside the same numbers.
