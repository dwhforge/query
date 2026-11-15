# Delta: Unified batch tuple matching

Decision: [ADR-0051](../../../../../docs/adr/0051-unified-matching-workspace.md).
Status: delivered requirements merged on 2026-11-15; remaining verification/extension work is tracked in tasks.md and report.md.

## MODIFIED Requirements

### Requirement: One Matching review replaces the separate Lens batch surface

Find Matches SHALL open the existing Matching tab in Basic configuration and
adapt the existing full-tuple Rust retrieval and optional batch LLM results into
its authoritative proposal/candidate/decision model. It SHALL NOT retain a second
Lens review or separately synchronized mutable batch decision queue. All ordered
JOIN pairs, pending/unselected defaults, explicit counted conservative bulk,
manual candidates, LLM allowlists/provenance, tuple safety, bounds, atomic commit,
receipt acknowledgement and explicit refresh requirements remain in force.

#### Scenario: Existing batch behavior through the shared review
- WHEN real tuple retrieval completes in Matching
- THEN score/field evidence, alternatives and omissions remain visible
- AND no target is selected/accepted automatically
- AND write uses the original JOIN-bound atomic Mapping + Apply path

### Requirement: Adjacent implementations and runtime semantics remain intact

Suggest Right and legacy scalar/composite Rust commands SHALL remain unchanged.
MatchingWorkspace SHALL now host Basic and Advanced, superseding only the old
separate-UI boundary and JOIN-bound output/Apply policy. No new matching engine,
storage kind, persisted format, runtime LLM, fuzzy JOIN ON, durable draft, global
assignment, detachment or arbitrary output rebinding is introduced. Existing
Mapping-origin persistence and live/demo separation SHALL remain authoritative.
