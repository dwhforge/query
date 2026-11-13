# Design: Matching Save acknowledgement

Keep host validation/merge planning in the existing Matching module, returning
intent only. Add a small testable persistence orchestrator with injected live
context/read/write dependencies. It re-reads source keys via existing readKeyMap,
checks live context after awaits, builds exact replacements and dirty baselines,
then classifies KeyMapSaveResult before acknowledging proposals.

App supplies current project/tab refs, import policy, connection resolution, and
the existing saveKeyMapToProject. MatchingWorkspace publishes the returned session
only after acknowledgement. No second Mapping store or new IPC is introduced.
External seed sync is retried even when locally staged rows already match.
A seed without an export target legitimately reports external skipped after
local AST success; classify that by binding, not as a refused warehouse write.
If external seed sync fails after local staging, return the still-confirmed draft
with that acknowledged local baseline so a retry can pass the concurrency gate
and retry the seed write. Never mark those proposals saved on this path.

Existing ADR-0031/0032/0033/0044/0045 contracts remain authoritative. Ref/query
and range-SCD bindings have no new Matching write semantics; refuse rather than
pretend that writing their entries changes the authoritative relation.
