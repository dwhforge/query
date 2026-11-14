# ADR-0048 — Query deletion preserves executable dependencies

## Status

Accepted (2026-11-14), implementing the owner's Query Graph Editing review:
controlled rejection is preferred to silently breaking dependencies.

## Decision

- Query creation preserves unrelated Workspace properties, especially KeyMaps.
  Derive and canvas edge removal use the existing pure queryEditing boundary.
- Query deletion refuses surviving FromQuery and explicit SQL `{{query:...}}`
  consumers rather than inventing replacement roots or rewriting arbitrary SQL.
- Query-backed KeyMaps and durable Mapping Checks are not implicitly deleted or
  rebound. Deletion refuses when their input closure needs the Query. Destructive
  edge removal also refuses when it changes such a protected input.
- Unprotected Join/Append references retain structural cleanup. Published
  `Project.outputs` entries for a deleted Query are removed explicitly; focus is
  repaired through existing rules. No transitive Query cascade is introduced.
- Before cleanup changes surviving Join/Append operations, the UI lists affected
  Queries and operations and requires confirmation. Pure application inspection
  exposes these consequences without React. Commit rechecks hard dependencies
  and refuses a changed graph; no-dependency deletion needs no extra prompt.
- A From edge can be removed only if no rootless transforms remain. Clearing a
  root-only Query is allowed as an empty editing draft only if no surviving
  Query, publication, query-backed Mapping or Mapping Check needs its output.
- Seed-map authoring context and immutable CheckRun history are provenance, not
  executable bindings; they are preserved. Standalone Sources are not garbage
  collected. General SQL expression/schema validation stays with the host.

No IPC/format change, dependency-manager framework or Rust migration.
Target-query revision tokens retain their existing, limited semantics.
Deletion confirmation uses a separate graph-snapshot token, not a new persisted
field or IPC contract.

Related: ADR-0013, ADR-0027, ADR-0032, ADR-0034, ADR-0036.
OpenSpec: [query-editing-integrity](../../openspec/changes/query-editing-integrity/proposal.md).
