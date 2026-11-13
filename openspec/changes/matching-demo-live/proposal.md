# Proposal: Matching demo/live separation (PR-00B)

Implement only the approved minimal-safe alternative under ADR-0047 and ADR-0044.
Current checkout is clean at c74d8a6 (PR-00A already in HEAD), rather than the
earlier assignment SHA. Preserve all PR-00A save acknowledgement behavior.

## In scope

1. Default live sessions; no fixture fallback for missing plan/input/host errors.
2. Explicit detached Demo fixtures session and persistent scope disclosure.
3. Demo and fixture-origin write refusal before Mapping context reads or writes.
4. Honest synthetic E2E save inputs plus live failure/demo isolation regressions.

## Out of scope

Live row acquisition, new host IPC/Rust infrastructure, lifecycle extraction,
store/bus, Compare, Join Lens rewriting, known broad Electron baseline failures.
No automatic run on entry. No claim that a demo proves live retrieval.

Review order: proposal → specs → design → tasks; reviewed autonomously under the
user's explicit slice approval. See [ADR-0047](../../../docs/adr/0047-matching-demo-live-boundary.md).
