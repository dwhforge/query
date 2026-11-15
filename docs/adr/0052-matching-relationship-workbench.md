# ADR-0052 — Record-centric, bidirectional Matching workbench

## Status

**Proposed — Phase 1 architecture only, 2026-11-15.** Not an accepted runtime
contract or an implementation claim. Review the
[proposal](../../openspec/changes/unified-matching-workbench/proposal.md) →
[capability deltas](../../openspec/changes/unified-matching-workbench/specs/) →
[design](../../openspec/changes/unified-matching-workbench/design.md) →
[gated tasks](../../openspec/changes/unified-matching-workbench/tasks.md).

## Context

The existing Matching tab exposes producers, tiers and technical identifiers more
prominently than source records, target records and decision consequences. Users
need to investigate both LEFT → RIGHT and RIGHT → LEFT without acquiring a second
decision authority. The [checkout investigation](../../openspec/changes/unified-matching-workbench/investigation.md)
records actual HEAD, reuse points, coverage limits and integration-test gaps.

## Proposed decision

1. Reshape the existing Matching tab into two business-record explorers and one
   relationship inspector, using the existing session owner and callbacks.
   [ADR-0051](0051-unified-matching-workspace.md) remains authoritative for plans,
   ledger, original JOIN ownership, verification and atomic Mapping + Apply.
   Basic/Advanced become execution details of a collapsed Matching Rules editor;
   optional LLM assistance becomes a secondary panel, not the primary workflow.
2. Treat focus, inspection selection and confirmation as independent states.
   Reverse navigation is read-only. Confirmation in either direction resolves
   the same exact source proposal and validated candidate into the same ledger.
   No new per-edge rejection, reverse ledger or persistence model is introduced.
3. Present actual JOIN, existing Mapping, confirmed draft and suggested
   relationships as separate groups. Multi-origin evidence is deduplicated within
   a group, never summed across groups into a purported association total.
   Mapping outputs are not independent target identities. Matching proposals
   are not evidence of JOIN participation or observed fan-out.
4. Build memoized reverse indexes from acquired proposal edges, candidates,
   decisions and a read-only projection of the authoritative Mapping definition.
   Preserve exact nullable ordered tuples, independent target identity, run and
   evidence revisions. Display labels never determine identity.
5. Reuse [key explanation](../../src/lib/bridge.ts:454) for explicit, read-only
   executed-JOIN inspection and existing Mapping reads where supported. Counts
   and samples have distinct coverage. Do not infer original alias lineage after
   arbitrary transformations or claim historical snapshot isolation.
6. Every relationship group discloses coverage and units. Unknown, not acquired,
   refused, sampled and verified zero are different states. Unsupported complete
   inspection refuses clearly, without silently substituting a sample.
7. No new RPC is authorized for this bounded redesign. Existing operations suffice
   for renderer reverse navigation, seed-definition baselines, bounded external
   Mapping pages and executed-key counts/samples. Complete external reverse
   filtering/pagination beyond those operations would require a separately
   evidenced Host contract; it is not implied by this visual redesign.

## Preserved decisions and boundaries

Preserve [facts-first JOIN investigation](0019-join-lens-ai-narrator.md),
[Mapping data-plane separation](0033-mapping-data-plane.md),
[query-backed Mapping authority](0036-query-backed-keymap.md),
[multi-output Mapping](0037-keymap-multi-output.md),
[sample/full disclosure](0041-heavy-preview-sample.md),
[demo/live separation](0047-matching-demo-live-boundary.md),
[Suggest Right](0049-unified-suggest-right.md) and
[full-tuple batch safety](0050-unified-batch-tuple-matching.md).

No scorer change, fuzzy JOIN ON, global assignment, new entity-resolution engine,
warehouse dictionary download, broad App/store refactor or durable draft restore.
No Accepted ADR is superseded: this proposal changes presentation and adds honest
relationship investigation within the existing ownership boundary.

## Consequences and acceptance

Many aliases → one target is legitimate; one target output tuple may identify
several independent target records. Both facts must remain visible without false
fan-out claims. Executed input keys may already be transformed, so original
Mapping aliases remain a separate view. Unsupported inspection is visible rather
than fabricated. Acceptance requires understandable business records **and**
working reverse investigation, real Electron/Host CSV journeys, cold reopen and
an existing Help Lab journey. Phase 1 changes documentation only; delivered
runtime deltas must later merge into the capability source of truth.
