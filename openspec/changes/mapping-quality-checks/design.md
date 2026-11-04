# Design — mapping-quality-checks (v1)

ADR-0027 Accepted. Implementation must not invent a second KeyMap store or silent
apply path.

## Objects

```text
MappingCheck {
  id, name
  map_id                     // KeyMap in project
  input_refs[]               // queries/sources that feed the overview join
  group_attributes[]         // user-chosen dimensions for the matrix
  cohort_predicate           // selection condition for the active cell/group
  allow_decisions[]          // optional: observed difference marked allowed + explanation
}

CheckRun {
  id, check_id, ran_at
  map_revision               // fingerprint of KeyMap (and seed SoT when applicable)
  input_revisions[]          // per-input version when knowable; else “unknown”
  check_definition_revision  // hash of attributes + predicate + map/input refs
  aggregates                 // bounded matrix / concentration payloads
  comparability              // full | limited(+reason)
}
```

Exact IR field names land in pipeline types when Accepted; this sketch is normative
intent for the OpenSpec scenarios.

## Cohort and Lens

- Lens opens with the check’s predicate as filter context (dynamic).
- Samples in UI remain bounded; the cohort is the condition, not an in-memory key cloud.
- Ephemeral ADR-0026 Inspect query may be reused as a transitional carrier, then
  replaced by check-scoped session state.

## Batch remap

1. User proposes From→To changes for the cohort (existing KeyMap editor / Lens map flows).
2. Preview shows affected links under frozen expected `map_revision`.
3. If current map or inputs diverge → refuse confirm; require new preview.
4. Confirm writes only through KeyMap Save / Apply ([ADR-0020](../../../docs/adr/0020-join-key-mapping.md)).

## Δ attribution

When comparing CheckRun A → B, classify:

| Signal | Label |
|--------|--------|
| map_revision differs, inputs stable | mapping changed |
| inputs differ, map stable | inputs changed |
| both differ | both changed |
| any required revision unknown | limited comparability |

Do not show a bare aggregate delta as proof of mapping improvement under limited comparability.

## Accept vs allow

- **Accept links** → KeyMap mutation path only.
- **Allow difference** → persists on MappingCheck with explanation; observation remains visible unless the user explicitly dismisses with that record.

## Lab relationship

ADR-0026 Help lab stays a deterministic demo. v1 production path is project KeyMaps;
lab may share UI patterns and projection ideas without remaining the only data path.
