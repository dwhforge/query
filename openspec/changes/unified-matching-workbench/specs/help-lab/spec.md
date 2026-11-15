# Delta: Help Lab — bidirectional Matching acceptance

Status: **proposed / not implemented**. Decision:
[ADR-0052](../../../../../docs/adr/0052-matching-relationship-workbench.md).
Extends [Help Lab](../../../../specs/help-lab/spec.md).

## ADDED Requirement

### Requirement: Existing lab teaches records, relationships and consequences

At least one existing offline lab SHALL demonstrate opening a problematic JOIN,
finding an unmatched source, inspecting real RIGHT candidates, focusing RIGHT and
its provenance-grouped LEFT relationships, explicitly confirming, reviewing the
Mapping diff, atomic Mapping + Apply and executing the changed JOIN. The journey
SHALL work without understanding Basic versus Advanced. Existing flagship
reconciliation, safe project switching and Suggest Right SHALL remain usable.

#### Scenario: Vendor name/region investigation
- GIVEN the existing vendor name/region lab opened through Help Lab
- WHEN a user investigates Germany aliases from its exact-pair JOIN
- THEN actual target labels and region values are visible, not opaque tuple IDs
- AND RIGHT focus separates executed rows, compatible saved Mapping, draft and suggestions
- WHEN the user confirms and reviews a relationship, writes Mapping + Apply and rechecks
- THEN actual CSV/DuckDB results reflect the explicit decision
- AND project Save plus cold Electron reopen retains the Mapping and equivalent execution
- AND the unrelated vendor-ID seed is not presented as a compatible name/region Mapping
