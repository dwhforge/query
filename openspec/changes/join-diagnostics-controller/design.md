# Design

Controller captures the existing QueryContext plus a local request generation.
Independent status/sample counters prevent out-of-order replies; analysis starts
invalidate status/sample work. A poll lifetime token rejects already-in-flight
polls after cleanup, independently of context. Current-input checks cover the
render/effect gap. A stable external-store snapshot owns all Join view state.

Hook supplies current target/project, context freshness, typed bridge operations
and preview preemption. It subscribes and synchronizes context cleanup/status;
its Lens busy callback captures context so late completion cannot end new work.
App supplies a diagnostic workspace transformation and a Data navigation effect.
The controller owns sample request sequencing, errors and presentation snapshot.

Join progress is composed over existing export/quality progress in App; stopping
Join work cannot erase another owner's bar. Quality Inspect's existing handoff
is cleared only when Lens actually starts. No host scheduler or lane changes.
ProjectSessionReset calls resetJoin once instead of seven individual setters.

Tests: delayed controller ports and deterministic polling; existing navigation,
execution, lifecycle/tabs/Matching/Help Lab Electron plus focused held Join replies.
Held transport support, if needed, is command-specific and E2E-only.
