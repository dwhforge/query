# Query preview controller

Merged from [PR-04A](../../changes/query-preview-controller/proposal.md), implementing
[ADR-0031](../../../docs/adr/0031-execution-lifecycle.md),
[ADR-0032](../../../docs/adr/0032-ui-host-decomposition.md) and
[ADR-0041](../../../docs/adr/0041-heavy-preview-sample.md).

## Requirements

### Requirement: Scenario-owned preview lifecycle

A dedicated Query preview controller SHALL own request generations, debounce,
phase/loading, result snapshot, error classification, cache, repeat refresh and
cancel. A small React hook SHALL adapt current inputs and narrow effects, not
receive a bag of App setters or leave orchestration in App. Existing requestGen,
previewTransport and host cancellation SHALL remain authoritative mechanisms.

### Requirement: Current input only

Fast query/step changes, same-target re-entry, tab ABA and committed project
replacement SHALL invalidate queued/running work. Late success, error and loading
completion SHALL NOT affect the current preview or client error banner. Cache
hits SHALL supersede earlier requests. Navigation context SHALL remain a staleness
token, not an execution scheduler. Join diagnostic progress remains separately
owned and guarded by existing context/session checks.

### Requirement: Preserved preview policy and reset boundary

Auto-preview SHALL remain structural sample LIMIT 50 including heavy focuses.
Full SHALL remain explicit, cached separately and labelled honestly. Recompute
SHALL clear the cache and repeat the current mode; authoring/source/project edits
SHALL invalidate cache. Cancel SHALL invalidate local completion and call the
existing host cancel. Committed replacement SHALL expose one preview reset port;
query navigation SHALL NOT reset Mapping/Matching. Preview errors SHALL NOT clear
project lifecycle errors. Typed navigation, demo non-write, live unavailable and
acknowledged Save behavior SHALL remain unchanged.

#### Scenario: ABA and repeated refresh
- WHEN a held preview is superseded by navigation away/back or same-target re-entry
- THEN its late success/error cannot publish, even if workspace identity matches again
- AND repeated Recompute runs the current mode afresh without changing selection

#### Scenario: Project replacement and cache
- WHEN replacement commits while a preview is held
- THEN one preview reset invalidates the reply, clears cache and restores sample mode
- AND the replacement's auto-preview cannot reuse the previous project's result
