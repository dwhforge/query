# ADR-0025 — References between DWHQuery projects

## Status

**Accepted** — merged SoT: [`openspec/specs/project-references/`](../../openspec/specs/project-references/). Change record: [`openspec/changes/project-references/`](../../openspec/changes/project-references/).

## Context

A saved `.dwhproj.json` is one editable project ([ADR-0009](0009-project-explorer.md), [ADR-0013](0013-project-persistence.md)). Teams still need to reuse another project’s sources, queries, and mappings without copying them into the local collections.

`Project.id` is a name slug (`proj_<slug>`, [ADR-0013](0013-project-persistence.md)). It is not a global identity. Query, source, and mapping ids are also slugs, unique only inside one file.

Connections are app-global ([ADR-0012](0012-connections.md)). One execution engine and one destination govern a project ([ADR-0014](0014-query-execution-affinity.md), [ADR-0015](0015-sources-vs-target-extensibility.md)). Seed maps become file-authoritative after export ([ADR-0020](0020-join-key-mapping.md)); live Postgres maps stay paged ([ADR-0022](0022-keymap-postgres-live-bind.md)); From identity is a tuple ([ADR-0024](0024-keymap-composite.md)).

Load steps embed a path or relation. They do not store a durable `source_id` (the TypeScript field is not in the Rust `QueryDef`). The executable edge is the Load payload; `Project.sources` is the catalog, including flags such as Hive partitioning matched by path and connection.

## Decision

### 1. Reference versus copy

A reference means “use this object from its owning project”. A copy means “create an independent local object”. They stay distinct in the file and in the UI.

The consumer does not append imported definitions to `workspace.queries`, `sources`, or `key_maps`. A runtime lowering adapter may assign ephemeral compiler ids. Those ids are never written back.

The first release exports one self-contained dbt project for the selected output closure. It does not emit `packages.yml` entries for these references and does not require dbt Mesh. “Self-contained” covers generated code and included seed data. It does not bundle source files, databases, credentials, or Python/dbt packages.

### 2. Identity

Add an immutable `project_uid`. Do not rewrite existing query, source, or mapping ids.

- New projects receive a `project_uid`.
- An older file receives one when its owner opens and saves it.
- A consumer must not write a referenced file to mint a uid. An owner file without a uid cannot be referenced until the owner saves it.
- Rename and move keep the uid. Save keeps the uid. A fork assigns a new uid and may keep internal object ids.
- If one resolved operation sees two different definitions for the same `project_uid`, it fails.
- Two reference rows may name the same uid only when their locked revisions are equal.

Object identity is `project_uid + kind + object id`. Kind is `source`, `query`, or `mapping`. Names, filenames, aliases, and paths are not identity.

On disk, a local target stays a bare string. An external target is an object:

```json
{ "scope": "reference", "reference_id": "ref_shared", "kind": "query", "id": "q_products" }
```

That form is used in `FromQuery.query_id`, `Join.right_query_id`, `Append.other_query_ids`, and `ApplyKeyMap.map_id`. The placeholder `{{query:id}}` stays local. An external placeholder is `{{xref:reference_id:query:object_id}}`. Nothing parses display names such as `Shared.Products` into identity.

### 3. Locator, revision, refresh

A reference stores `id`, `alias`, a relative `locator`, `expected_project_uid`, and `locked_revision`. The locator is resolved against the directory of the project file that declares it, including a reference declared by an owner. `root_path` stays runtime-only.

The first save of the root project is required before a relative locator can be stored.

Relink replaces the locator only after the chosen file has the expected uid. A same-named file with another uid does not replace the reference.

The revision is a semantic fingerprint computed only in `dwh-pipeline`. It covers executable definitions, the execution engine, relevant source configuration, mapping column semantics, authoritative seed bytes, and the locked revisions of the owner’s own references. It excludes canvas layout, focus, outputs, destination, materialization, dbt target, credentials, aliases, and absolute export paths.

Saved owner state is what a reference sees. Unsaved edits in another window are not visible. A changed owner file is “Update available”. Refresh stages the new fingerprint, validates the closure, and replaces the lock only when that succeeds. There is no durable embedded copy of the owner. If the locked bytes cannot be read again, operations that need them are blocked. An in-memory snapshot already checked for that lock may finish the operation that captured it. Data changes in Postgres, S3, or files are not frozen by a definition revision.

When a seed map’s export CSV is authoritative ([ADR-0020](0020-join-key-mapping.md)), the fingerprint hashes that CSV. A missing authoritative seed blocks use. The consumer never writes the owner project or the owner’s seed file.

### 4. One resolver, then the existing compilers

One resolver returns an immutable closure, provenance, connection requirements, revisions, and diagnostics. Preview starts at the selected query. Export starts at the root project’s selected outputs. An unused reference that cannot be opened does not block an unrelated local preview or export.

Lowering produces an ordinary `Workspace` plus `SourceDef`s for the compilers that already exist. Preview, schema inference, Join Lens, and dbt export do not each expand references. External queries are not added to the root project’s published outputs. The owner’s `focus_query_id` is not copied into the lowered workspace.

Cycles in the active reference closure and in the executable object graph fail with a path. Detection uses identities. Unused reference edges that the operation does not reach do not fail that operation. Raw SQL is not scanned for bare identifiers. Unsupported dynamic dependencies fail with a diagnostic.

Structured steps are emitted again in the root engine ([ADR-0015](0015-sources-vs-target-extensibility.md)). `SqlModel`, `CustomSql`, and free-SQL `DeriveColumn` fail when their dialect is not the root engine. The owner’s destination and published marts are not adopted.

### 5. Paths, connections, mappings

Structured relative Load paths of an external object resolve against the owner project directory. Export may embed the absolute owner path in generated SQL; the provenance manifest does not. Opaque SQL that contains a relative file read fails with guidance instead of being rewritten.

Connection requirements are qualified by owner uid and owner connection id. The binding table in the consumer project maps that pair to a global connection id ([ADR-0012](0012-connections.md)). It stores no secret. Auto-bind applies only when that same global connection id already exists in this installation’s store. Otherwise the UI asks. Display names are not matched. The consumer does not call mapping write-back.

Seed, Postgres source, and dbt `ref` storage keep their current contracts, including composite From ([ADR-0024](0024-keymap-composite.md)). External mapping definitions are read-only in the consumer. A local copy copies one definition, keeps external targets external, and does not copy a live table.

### 6. Export names

Local objects keep today’s `stg_` / `int_` / `mart_` names. External objects use a deterministic short hash of `project_uid`, the kind, and the object id, so the identifier fits warehouse limits. The full triple is in `dwhq_provenance.json` together with the locked revision and the generated name. The manifest omits credentials, absolute paths, and timestamps.

Postgres `source()` names for external relations are namespaced the same way. The database schema and table stay the relation address.

Re-export of an unchanged closure is byte-stable for generated paths, `ref` targets, seeds, and provenance. A diamond emits one object. Owner publication settings do not add marts.

## Consequences

- [ADR-0013](0013-project-persistence.md) still governs object ids. Only the project gains a global uid.
- OpenSpec: [`openspec/specs/project-references/`](../../openspec/specs/project-references/) (change: [`openspec/changes/project-references/`](../../openspec/changes/project-references/)).
- Release notes must state local-file scope, explicit update, the cycle restriction, read-only consumer behavior, the owner-save migration gate, and that live database rows are not pinned.

## Out of scope (first release)

Git or registry download, arbitrary dbt-project import, automatic upgrades, cross-project edit transactions, local overrides of external definitions, dbt Mesh, and new mapping backends.

## References

- [ADR-0009](0009-project-explorer.md), [ADR-0012](0012-connections.md), [ADR-0013](0013-project-persistence.md), [ADR-0014](0014-query-execution-affinity.md), [ADR-0015](0015-sources-vs-target-extensibility.md), [ADR-0018](0018-return-and-edit.md), [ADR-0020](0020-join-key-mapping.md), [ADR-0022](0022-keymap-postgres-live-bind.md), [ADR-0024](0024-keymap-composite.md)
