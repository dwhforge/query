# PR-00A delivery report

Scope is Matching Save acknowledgement only. PR-00B and PR-01–06 are not
implemented. The assignment was checked against current HEAD; see the separate
[assignment review and baseline](../../../docs/stabilization/PR-00A-baseline.md).

## Before / after responsibilities

| File | Before | After |
|---|---|---|
| `src/app/matching/commitSave.ts` | Host validation/planning plus premature Saved state | Host validation/planning only; no local materialization fallback or settlement |
| `src/app/matching/persistSave.ts` | Absent | Small injected orchestration: live context, exact source baselines, planned tuple replacements, persistence outcome, acknowledgement |
| `src/components/MatchingWorkspace.tsx` | Published Saved before callback; success on any resolved promise | Publishes only acknowledged session; failure stays retryable; local Mapping vs project-file saving copy |
| `src/App.tsx` | Cached map/editor fallback, fill-only merge, ignored save result | Supplies current owners/bindings/policy/read/write dependencies; existing persistence remains authoritative |

The existing persistence implementation changes only to preserve Mapping editor
edits made during a Matching-owned source write. It does not change the default
editor or check Confirm save behavior. Matching also holds the existing map-write
replacement guard through baseline reads/planning, not just the write.

## Preserved contracts

- ADR-0031 request/cancel semantics and FIFO mutation lane; no mutation rollback claim.
- ADR-0032 scenario services; no store, bus, runtime, or registry.
- ADR-0033 source row bodies stay outside project IR; existing exact-key read and dirty delta.
- ADR-0044 human-confirmed, host-gated decisions; no silent partial success or runtime Apply.
- ADR-0045 safe project replacement and ADR-0046 Help Lab guidance remain unchanged.
- No Rust source, IPC schema, persisted project format/version, preview, or Join Lens rewrite.
- Query/ref and range-SCD bindings gain no new row-write semantics; unsupported writes refuse.
- A seed with no linked export legitimately returns external skipped after local
  Mapping success. Skipped required warehouse/linked-seed writes do not count as success.

## Validation evidence

- Baseline: installation/build/unit passed; full Electron **33 passed, 2 failed,
  2 skipped** before source edits. The exact failures are in the baseline report.
- Native focused suites: **25 engine Matching tests** and **5 host Matching
  tests passed**. These are filtered suites, not full package-suite passes.
- Final unit suite: **all 32 test files passed**.
- Final ordinary production build: **passed** (2.91s), with the existing
  large-chunk warning; log `/tmp/dwh-query-pr00a-production-final.log`.
- Final Electron-target UI build/typecheck: **passed**, with the existing
  large-chunk warning; the focused E2E entry point also rebuilt the release host.
- Final focused Electron suite: **4 passed (24.2s)** under an isolated virtual
  display. Cases: missing map, absent target ID, real seed failure/retry without
  success copy, real local Mapping save plus project save/reopen of one tuple.
- Final whitespace validation: **git diff --check passed**.
- Initial new negative Electron assertions passed but teardown timed out on the
  intentionally retained dirty draft. Test cleanup now explicitly discards only
  its injected fixture state after assertions; production beforeunload remains.
- A subsequent run exposed unexported-seed external-skipped semantics; the
  classifier was corrected and a unit regression added. That run was **3 passed,
  1 failed**, not counted as a pass.
- Broader post-change Electron rerun was interrupted at the known baseline
  flagship comparison assertion: **12 passed, 1 interrupted, 28 not run**.
  It is incomplete and is not a green regression suite.

Local raw logs: `/tmp/dwh-query-pr00a-*`; baseline logs are in
`/tmp/dwh-query-pr00a-baseline/`.
Final unit/Electron logs are `/tmp/dwh-query-pr00a-unit-verified.log` and
`/tmp/dwh-query-pr00a-e2e-verified.log`.

## Coverage and remaining limits

Unit coverage includes missing target/map, unavailable bindings/import policy,
output/key shape, pending write dirty state, acknowledged save, verified no-op,
repeat save and changed saved rows, seed external error/conflict/skipped plus
retry after local staging, source exact baselines and external failures,
explicit replacement preserving attrs, rejected materialization, cancellation,
and map/session/project changes across async work.

Electron uses an explicitly injected fixture decision session to isolate PR-00A;
host draft validation, commit planning, seed persistence and project save/load
are real. This is not proof of live Matching retrieval. The project-file
save/reopen case uses existing E2E helpers, not a new native-dialog happy path.

Human manual smoke, real PostgreSQL write/error races, cross-platform visual
checks, the full own-data/restart/export journey, and the complete flagship
repair/Save As/reopen journey are **not claimed passed**. The baseline broad
Electron failures are not fixed in this PR. Live/fixture separation remains
PR-00B, and original-query Lens navigation remains PR-03.

Recommended manual smoke: explicitly prepare/confirm a Matching decision, force
a seed or warehouse failure, verify retained draft/retry and no success copy,
then save successfully, save the project, reopen, and inspect the exact tuple.
For source maps, edit the separate Mapping editor while the write is held and
verify that those newer edits remain dirty rather than being settled by Matching.
