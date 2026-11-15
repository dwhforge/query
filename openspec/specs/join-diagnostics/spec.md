# Join diagnostics and preparation

Merged from [PR-04B](../../changes/join-diagnostics-controller/proposal.md).
Implements [ADR-0031](../../../docs/adr/0031-execution-lifecycle.md) and
[ADR-0032](../../../docs/adr/0032-ui-host-decomposition.md), retaining
ADR-0041/0044/0045/0046/0047. Evidence and PR-05 boundaries are in the
[delivery report](../../changes/join-diagnostics-controller/report.md).

## Requirements

### Requirement: Scenario-owned Join session

A dedicated controller and narrow hook SHALL own panel preparation, diagnostics,
prepared status, numeric progress, Lens busy reporting and diagnostic sample
handoff. App SHALL retain rendering and domain workspace construction ports,
not a setter bag. Query preview and Join Lens internal execution remain separate.
Analysis SHALL use existing host cancellation and preview preemption unchanged.

### Requirement: Exact current context and newest intent

Late success, error, status, progress and sample replies SHALL NOT publish after
supersession, cancel, query/step/view/graph changes, same-target ABA or committed
project replacement. Pending poll replies SHALL be invalid after polling stops.
Status requests SHALL not overwrite newer prepare results. Diagnostic samples
SHALL remain separate from the ordinary preview and newest sample intent wins.

#### Scenario: Superseded preparation and polling
- WHEN a second prepare or diagnostics request starts in the same context
- THEN older completion/error/status/progress cannot alter the newer state
- AND progress uses finite numeric percentages clamped to 0–100

#### Scenario: Navigation, cancel and replacement
- WHEN navigation changes context, cancel is requested or replacement commits
- THEN local work and outstanding poll replies are invalidated
- AND late replies cannot reopen diagnostic panels or clear newer progress
- AND committed replacement exposes one Join reset port

### Requirement: Preserve independent owners

Typed tabs, original Matching Join captures, separate lifecycle errors, explicit
non-writing demo/live-unavailable policy, acknowledged Mapping Save, no-rollback
mutation semantics, sample/full preview and Help Lab behavior SHALL not change.
QueryContext remains a transient stale token, not an execution framework.

## ADR-0052 — record-first relationship workbench

Decision: [ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
Verified bounded delivery: [runtime evidence and residual limits](../../changes/unified-matching-workbench/runtime-report.md).
This amends presentation only; existing session, ledger and write authority remain.

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
