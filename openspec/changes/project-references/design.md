# Design: Project references

Normative behavior is [ADR-0025](../../../docs/adr/0025-project-references.md) and `specs/project-references/spec.md`. This file is how the first release fits the current crates.

## Wire

`Project` gains:

```text
project_uid: string                 # empty until the owner saves
references: ProjectReference[]      # default []
connection_bindings: ConnectionBinding[]
```

```text
ProjectReference { id, alias, locator, expected_project_uid, locked_revision }
ConnectionBinding { owner_project_uid, owner_connection_id, local_connection_id }
```

`ObjectTarget` deserializes from a string (local id) or from `{ scope: "reference", reference_id, kind, id }`. Local saves stay bare strings. Compiler entry points call `compiler_id()` and receive an error if an external target was not lowered.

`{{query:id}}` remains a local placeholder. `{{xref:reference_id:query:object_id}}` is the external form. Lowering rewrites it to `{{query:<compiler id>}}`.

Save mints `project_uid` when the file and the in-memory project both lack one. A later save that omits the field keeps the uid already in the file. A consumer save never opens an owner path for writing.

## Revision

`project_revision(project, project_file)` in `dwh-pipeline` hashes canonical JSON of:

- `project_uid`, `execution_engine`
- sources except `connection_string`
- queries (`id`, `name`, `execution`, `steps`)
- mappings: storage, From/To columns, editable columns; seed entries **or** the sha256 of the authoritative `seeds/map_*.csv` when `last_dbt_export_path` is set
- each declared reference’s `expected_project_uid` and `locked_revision` (not the alias or locator)

A missing authoritative seed is an error, not a fallback to stale JSON entries.

## Resolver and lowering

`resolve_operation` walks only the operation roots (preview query, export outputs, or every local query for validate). It dedupes by `(project_uid, kind, id)`, detects cycles with an explicit stack, and checks each owner file’s live revision against the lock that cited it.

Lowering:

- local ids unchanged
- external compiler id `x{kind}{8-hex-uid}_{sanitized object id}`
- external query **name** set to `stg_` or `int_` plus that short uid and object id, so `dbt_model_name` keeps the stem and does not treat the query as a mart
- relative `LoadCsv` / `LoadParquet` / `LoadDuckdb` paths become absolute against the owner directory
- matching owner `SourceDef`s are copied with the same path rewrite so Hive lookup still matches
- `connection_id` rewritten through the binding table, or kept when the same global id is in the session connection list
- seed mappings with an authoritative CSV take their entries from that file for the lowered value
- published ids are the root project’s `outputs` (or focus when `outputs` is empty), restricted to local query ids

`dwhq_provenance.json` is added to the export plan only when the closure contains an external object. Fields: owner uid, kind, object id, locked revision, generated name. No alias, path, credential, or timestamp.

Postgres `source()` for an external Load or KeyMap source uses a namespaced dbt source name. `LoadPostgres.source_alias` / `LoadDuckdb.source_alias` and `KeyMapStorage::Source.db_schema` carry the real database schema. When those fields are absent, export matches today’s names.

## Host

Preview, describe, and export accept an optional reference context (project directory, uid, references, bindings, engine, outputs). When the workspace closure contains an external target, the host lowers once and compiles that snapshot. The preview request id already drops stale responses. Cache keys are taken on the lowered workspace, so an accepted refresh changes the key and leaves unrelated entries in place.

## UI

Explorer gains a References section ahead of Export. Adding a reference requires a saved root file. The host prepares uid, revision, and a relative locator. Remove is refused while a root step still cites the reference. External `FromQuery` / `Join` / `Append` targets become collapsed boundary nodes; the existing REF marker stays the local-FromQuery marker.

## Tests

Pipeline tests cover identity, alias, relocate, fork, diamond, cycles, unused missing references, owner-relative paths, seed refresh, and composite From. Engine e2e writes an owner and a consumer, previews, `dbt build`s the DuckDB route, and checks the row multiset. The DuckDB → Postgres route runs when `DWH_PG_DSN` is set; otherwise the test still asserts the generated project is the attach route and was not hand-edited.
