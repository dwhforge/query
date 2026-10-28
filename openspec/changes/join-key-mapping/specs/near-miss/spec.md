# Spec Delta: near-miss

## Purpose

Suggest deterministic key normalizations that strictly improve distinct key overlap; Apply inserts an explicit NormalizeKey step (never auto Join ON).

## ADDED Requirements

### Requirement: Near-miss API scores overlap delta

`join_key_near_miss(host, join_ix)` SHALL compute baseline distinct key overlap on full Join inputs and return only hypotheses with `delta_matches > 0`, including apply side and sample converging pairs.

#### Scenario: Positive delta only
- **GIVEN** a Join whose unmatched keys would match after `trim`+`lower` on the left
- **WHEN** near-miss is requested
- **THEN** a hypothesis with those ops and `apply_on=left` (or both) appears with `delta_matches > 0`
- **AND** hypotheses with zero or negative delta are omitted

### Requirement: Apply inserts NormalizeKey

Applying a hypothesis SHALL insert (or update) `NormalizeKey` on the chosen side(s) before the Join, without changing `left_on` / `right_on`.

#### Scenario: Apply left
- **WHEN** the user Applies a left-side hypothesis on host Join step index `i`
- **THEN** a NormalizeKey step appears on the host query at index `i` (Join shifts to `i+1`)
- **AND** Join key column names are unchanged
