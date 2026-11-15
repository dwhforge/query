# Delta: JOIN diagnostics — Matching relationship inspection

Status: **verified bounded delivery merged into capability specs, 2026-11-15**. Decision:
[ADR-0052](../../../../../docs/adr/0052-matching-relationship-workbench.md).
Extends [JOIN diagnostics](../../../../specs/join-diagnostics/spec.md); does not
transfer existing controller ownership or replace Lens.

## ADDED Requirements

### Requirement: Explicit executed-key inspection

The Matching workbench SHALL offer explicit read-only actual-JOIN inspection for a
focused RIGHT output tuple using the existing key explanation operation against
the session's original JOIN and current validated context. It SHALL label fresh
query-time evidence separately from an earlier preview or Matching run. Counts
SHALL retain row units; displayed records SHALL retain their sample limits.

#### Scenario: More related rows than displayed examples
- GIVEN the key explanation returns more than 50 matching LEFT rows
- WHEN RIGHT inspection displays those facts
- THEN the total is an executed input-row count and the displayed list is a sample
- AND distinct original alias totals and full enumeration are not fabricated
- AND a request for unsupported complete enumeration reports unavailable, not sampled success

### Requirement: Actual participation and cardinality are execution facts

Suggested and saved/draft Mapping relationships SHALL NOT be labelled actual JOIN
relationships without execution evidence. Duplicate acquired RIGHT occurrences MAY
warn that applying that output could multiply rows, but SHALL NOT assert current
fan-out. Executed partner/input/output counts, NULL equality and outer-JOIN rows
SHALL be interpreted using actual JOIN semantics. Output-key groups SHALL NOT be
misrepresented as one independently identified target row.

#### Scenario: Many aliases, one business target
- GIVEN several proposed or mapped aliases for one RIGHT entity
- THEN many-to-one Mapping is not an error or proof of current result multiplication
- WHEN actual diagnostics demonstrate multiple target rows per LEFT input
- THEN the UI shows an executed fan-out warning with its evidence and scope

### Requirement: No unsupported lineage or snapshot claim

Post-Mapping executed LEFT input keys SHALL be identified as transformed JOIN input
keys. The workbench SHALL NOT claim it recovered original aliases through arbitrary
transforms. Unsupported exact value/type translation, acquisition error, cancellation
or stale context SHALL report unavailable/refused, not zero. Read-only inspection
SHALL NOT authorize writes or imply external snapshot isolation.
