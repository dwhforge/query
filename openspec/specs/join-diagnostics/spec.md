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
