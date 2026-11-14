# Design

`src/app/queryEditing/operations.ts` owns small named functions and a shared
result shape, not a speculative GraphAction union or execution service.
Reuse existing Join key normalization, ObjectTarget helpers and Source sync.

The existing ProjectBag reducer accepts a pure operation closure plus project
identity. It computes the result from `state.project` and records a receipt.
App consumes that receipt in an effect, reports errors and maps selection intent
to `createQueryNavigation().openQuery`. Receipt context checks prevent stale
effects after project replacement. No second project store or ref-based commit.

Preserve structural deletion's current scope: surviving rootless queries may
need author repair; raw SQL placeholders, map authoring context and saved output
metadata are not automatically rewritten. Sources are a standalone catalog,
not garbage-collected Load bodies. JOIN input uses typed ObjectTarget; external
queries are not looked up as local Query IDs. No cycle-policy redesign.

Tests independently exercise frozen snapshots, deep deletion, external versus
local identities, JOIN update/append/empty keys, invalid/duplicate IDs, root
guards, sequential operations and committed selection. Electron verifies actual
JOIN selection and Inspector edits through real UI/host paths.
