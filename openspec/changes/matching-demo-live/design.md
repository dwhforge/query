# Design: Explicit Matching demo/live boundary

Add an in-process execution mode to Matching sessions, defaulting to live in the
existing constructor. A small policy helper provides a shared write refusal and
constructs detached demo sessions. No mode is persisted in project IR.

The trial module rejects invalid live inputs and propagates host failures. Its
explicit demo branch alone loads fixtures; the fixture loader refuses live
sessions. Existing live helper takes injected retrieval for deterministic unit
tests; default remains the existing typed bridge. UI uses the demo branch only
in a demo session; ordinary sessions show an unavailable notice and do not
pretend to acquire rows. Mapping entry no longer defaults to a fixture plan.

App's Demo fixtures callback creates a new tab, not a mode switch on a live draft.
Demo's plan/results cannot inherit the original target/map baseline or Lens
navigation. A persistent demo banner makes the limitation visible after review
or LLM ranking. Both the Save UI and persistence orchestrator enforce refusal;
the latter also rejects fixture provenance independently of mode. Include mode
in PR-00A's async revision comparison.

PR-00A Electron save cases will use independent, explicitly synthetic live
candidate/proposal data, not imports from production fixtures. Host accept/plan
and actual persistence still run. Add a demo attach-target refusal case and an
ordinary-live unavailable → explicit-demo journey. Negative-test teardown keeps
explicit draft discard to avoid beforeunload hangs.

Preserve ADR-0031 cancellation/no rollback, ADR-0032 scenario modules, ADR-0044
human/host gates, ADR-0045 safe replacement and ADR-0046 bounded lab assistance.
