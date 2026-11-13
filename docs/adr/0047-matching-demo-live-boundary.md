# ADR-0047 — Explicit Matching demo/live boundary

## Status

**Accepted** (2026-11-13), implementing the user-approved PR-00B minimal-safe
alternative. This tightens ADR-0044; it does not authorize a new retrieval system.

## Decision

- Ordinary Matching sessions are live. Missing plan, unavailable/empty source or
  target rows, and host rejection/cancellation/error never fall back to fixtures.
  Without confirmed live row acquisition, the UI reports unavailable, not success.
- Offline fixtures require an explicit **Demo fixtures** action opening a separate
  session, detached from the user's Mapping and Lens context. Demo results remain
  visibly labelled, including after optional LLM ranking. Demo decisions cannot
  be written through Matching Save, even if a target Mapping is later attached.
  Fixture-provenance proposals also refuse persistence in a live session.
- Keep the offline example reproducible. Do not infer demo authority from query
  names, Help Lab state, target map names, or an error. No production bypass flag.
- Tests may inject explicitly synthetic live evidence through the existing
  E2E-only session hook to exercise real save validation/persistence. Such tests
  must not claim live retrieval coverage or relabel fixture output as live.

## Consequences

PR-00B deliberately reports live UI retrieval unavailable until a later slice can
bind actual rows to the confirmed plan. The existing live retrieval helper remains
testable with explicit row inputs and the existing typed host command. No IPC,
Rust, persisted IR, store, bus, Compare or Join Lens rewrite is introduced.
ADR-0031/0032/0044/0045/0046 and PR-00A acknowledgement remain authoritative.

Review packet: [matching-demo-live](../../openspec/changes/matching-demo-live/proposal.md).
Merged contract: [Matching workspace](../../openspec/specs/matching-workspace/spec.md).
