# Phase 1 delivery report — architecture only

## Scope and checkout

Prepared 2026-11-15 on branch **feature/redesign**, baseline HEAD
**0c152c8fa0a8b86f037389617ba8eb9a8d24a9cd**, initially clean working tree.
No commit, runtime implementation, algorithm/RPC/IR change or test modification.
Architecture review is pending; Phases 2–4 have not started.

## Delivered packet

- [Proposed ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
- [OpenSpec proposal](proposal.md).
- [Matching delta](specs/matching-workspace/spec.md),
  [JOIN diagnostics delta](specs/join-diagnostics/spec.md) and
  [Help Lab delta](specs/help-lab/spec.md).
- [Architecture, layout/navigation and provenance/coverage design](design.md).
- [Checkout investigation and existing-capability reuse inventory](investigation.md).
- [Phased tasks, acceptance gates and integration matrix](tasks.md).
- [OpenSpec index](../../README.md) entry marking this as proposed, not delivered runtime.

## Principal conclusions

1. Use one existing Matching tab/session/decision ledger. Reverse navigation is a
   read-only sparse projection, not a second matching or decision system.
2. Separate actual JOIN, existing Mapping, confirmed draft and suggestions, with
   independent coverage, units and non-additive counts.
3. No new Host RPC is required for the **bounded** contract. Existing operations
   provide source-scoped lookup, Mapping reads and executed-key counts/samples.
   Complete large external reverse enumeration is not supported by those APIs;
   report/refuse it explicitly instead of silently sampling or full-downloading.
4. Empty session baseline arrays are not proof of an empty Mapping. Source page
   hashes are not full-table snapshot tokens. Saved output tuples are not always
   independent target identities. Query-time JOIN facts are not a historical
   preview snapshot or generic original-alias lineage.
5. The existing vendor lab can demonstrate reverse investigation and write/recheck.
   Its vendor-ID seed must not be misbound as the exact-pair name/region baseline.
6. Real Electron/Host journeys, cold reopen, concurrency cases and Help Lab product
   acceptance remain mandatory future gates. Historical test reports are evidence
   of the predecessor only, not verification of this proposed redesign.

## Validation performed

| Check | Result |
|---|---|
| Initial branch, HEAD and short worktree status | Recorded; clean baseline |
| Whitespace/diff check | Passed |
| Packet and index local links, including source line-range bounds | Passed final check: 10 documents / 278 links; trailing whitespace clean |
| Changed-file scope check | Passed: 10 documentation-only files; runtime and merged capability specs untouched |
| Existing [UX documentation check](../../../scripts/test-ux-docs.mjs) | Passed: 26 documents, 117 links/media references and source/license assertions; remote HTTP checks not requested |
| Runtime build/unit/browser/Electron/native tests | **Not run**: Phase 1 deliberately changes documentation only |

The packet-specific local-link check covers the new documents; the existing UX
check has its own fixed scope and is not presented as validating proposed runtime
behavior. Only the proposed ADR, this change directory and the OpenSpec index are
modified. No proposed delta has been merged into the capability source of truth.

## Review and completion boundary

Review proposal → specs → design → tasks. Do not begin runtime work ahead of Gate
1. Phase 1 packet preparation is complete; the redesign is **not implemented or
product-accepted**. Once runtime phases are verified, merge delivered deltas into
the merged capability specifications and record actual test evidence before
closing the change. Predecessor residual risks remain open independently.
