# Spec: project-references

Behavior contract for [ADR-0025](../../../docs/adr/0025-project-references.md). Requirements below use SHALL. Existing local projects that declare no references keep their current preview and export.

## Requirements

### Requirement: Stable project identity

The system SHALL persist an immutable `project_uid` on the project. Project names, filenames, reference aliases, file paths, and the name-derived `Project.id` SHALL NOT be used as cross-project identity. Query, source, and mapping ids SHALL stay unchanged when a `project_uid` is assigned.

A new project SHALL receive a `project_uid`. An older project SHALL receive one when its owner saves it. A consumer SHALL NOT write a referenced file in order to assign that uid. Rename, move, and Save SHALL keep the uid. A fork SHALL assign a new uid and MAY keep internal object ids.

Two definitions that claim the same `project_uid` with different content in one resolved operation SHALL fail. Two reference rows for the same uid SHALL be accepted only when their locked revisions are equal.

#### Scenario: Equal names and local ids

- **GIVEN** two owner projects both named "Shared", each with a query id `q_products`
- **WHEN** a root project references both
- **THEN** the objects stay distinct because their `project_uid` values differ

#### Scenario: Reference alias is renamed

- **WHEN** a reference alias changes and the locked revision does not
- **THEN** object identity and generated model and ref targets stay the same

#### Scenario: Owner file has no uid

- **GIVEN** an owner file without `project_uid`
- **WHEN** a consumer tries to add a reference to it
- **THEN** the operation fails and tells the user to open and save the owner project
- **AND** the owner file is not modified

#### Scenario: Fork

- **WHEN** a project is forked
- **THEN** it has a new `project_uid` and the same query, source, and mapping ids

### Requirement: Typed targets

Local targets SHALL remain bare strings on disk. External targets SHALL be stored as `{ scope: "reference", reference_id, kind, id }` on `FromQuery`, `Join`, `Append`, and `ApplyKeyMap`. Kind SHALL be `source`, `query`, or `mapping`.

`{{query:id}}` SHALL mean a local query. `{{xref:reference_id:query:object_id}}` SHALL mean an external query. The system SHALL NOT parse dotted display names into identity.

Imported definitions SHALL NOT be appended to the root project's editable `workspace.queries`, `sources`, or `key_maps`.

#### Scenario: Legacy project loads

- **GIVEN** a project whose steps use string query ids and map ids
- **WHEN** it is loaded and saved with no references
- **THEN** those fields are still strings and mean the same local objects

### Requirement: Saved definitions and explicit refresh

A reference SHALL record the owner uid and a semantic revision of the owner's saved state. Unsaved edits in another window SHALL NOT become visible. Opening a project SHALL check declared locators. A changed owner file SHALL surface as update available and SHALL NOT be executed until an explicit refresh succeeds.

Refresh SHALL validate the affected closure and replace the locked revision only on success. A failed refresh SHALL leave the previous lock unchanged and SHALL name the dependency path.

The revision SHALL include executable definitions, the execution engine, relevant source configuration, mapping semantics, authoritative seed contents, and locked revisions of references declared by the owner. It SHALL exclude canvas positions, focus, outputs, destination, materialization, dbt target, credential values, aliases, and absolute paths. Layout-only changes SHALL NOT create an upgrade.

There SHALL be no required embedded copy of the owner. If the pinned revision cannot be reconstructed, operations that need it SHALL be blocked. Postgres, S3, and file row changes SHALL NOT by themselves change the definition revision.

When an owner seed is authoritative, the revision SHALL hash that seed file. Stale entries in the owner JSON SHALL NOT replace a missing or changed seed. The consumer SHALL NOT write the owner project or the owner seed.

#### Scenario: Owner saved a new transformation

- **WHEN** the owner query changes on disk
- **THEN** the root reports an available update
- **AND** a new preview or export that needs that query fails until refresh

#### Scenario: Refresh fails

- **WHEN** an update introduces a missing object or a cycle
- **THEN** the previous lock is unchanged and the error names the dependency path

#### Scenario: Authoritative seed missing

- **GIVEN** an owner seed map whose export CSV is the source of truth
- **WHEN** that CSV cannot be read
- **THEN** the consumer does not fall back to stale project entries

### Requirement: Locate by path, verify by identity

Relative locators SHALL resolve against the directory of the project file that declares them, including a locator declared by an owner. A relative reference SHALL be persisted only after the root project has a file path. Relink SHALL change the locator only after `expected_project_uid` matches the chosen file.

#### Scenario: Referenced project moved

- **WHEN** the owner file is missing at the stored locator
- **THEN** the reference is unavailable
- **AND** relink restores it when the chosen file has the same uid

#### Scenario: Same name, different uid

- **WHEN** relink selects a file whose uid differs
- **THEN** the locator is left unchanged

### Requirement: Resolve one closure

One resolver SHALL return the reachable objects, provenance, connection requirements, revisions, and diagnostics. It SHALL follow `FromQuery`, `Join`, `Append`, `ApplyKeyMap`, `{{query:}}` / `{{xref:}}` placeholders, and external targets inside referenced objects. It SHALL dedupe by `project_uid + kind + id`, including diamonds.

Preview SHALL resolve the selected query. Export SHALL resolve the root project's selected outputs and SHALL NOT publish an owner's marts merely because that project is referenced. An unavailable reference that the operation does not reach SHALL NOT block an unrelated local preview or export.

The compilers SHALL consume a lowered workspace. They SHALL NOT expand references independently. Lowered compiler ids SHALL NOT be written into the root project.

An external query's Load path SHALL bring along the owner `SourceDef` that matches that path so source flags such as Hive partitioning still apply.

#### Scenario: One shared mapping, multiple consumers

- **GIVEN** two local queries use the same external mapping
- **THEN** resolution and export include one mapping object
- **AND** each use keeps its own ApplyKeyMap columns and output column

#### Scenario: Unused missing reference

- **GIVEN** a reference whose file is missing and no local step cites it
- **WHEN** a local query is previewed
- **THEN** the preview runs

### Requirement: Cycles and unsupported dependencies

The active reference closure and the executable object graph SHALL reject cycles with a readable path. Detection SHALL use identities and SHALL NOT recurse until the stack overflows. A cycle that the operation does not reach SHALL NOT fail that operation.

The system SHALL NOT discover dependencies by rewriting arbitrary SQL identifiers. An unresolvable external dependency SHALL fail with a diagnostic that names the object.

#### Scenario: Transitive cycle

- **GIVEN** project A uses project B and B's used dependency points back at A
- **WHEN** the closure is resolved
- **THEN** the operation fails with the cycle path and does not emit partial SQL

### Requirement: Execution semantics

The root project's engine and destination SHALL govern the operation. Structured steps from an owner SHALL be emitted in the root engine. `SqlModel`, `CustomSql`, and free-SQL `DeriveColumn` SHALL fail before execution when their dialect is not the root engine. The owner's destination and output list SHALL NOT be applied to the consumer.

A local query MAY start from an external query and add local steps. The owner query SHALL remain unchanged.

#### Scenario: Incompatible SQL dialect

- **WHEN** a referenced query contains SQL authored for a different engine than the root
- **THEN** preview and export name that object and the incompatibility
- **AND** they do not emit the foreign SQL as if it were portable

### Requirement: Owner context for paths and connections

Structured relative source paths on an external object SHALL resolve against the owner project directory. Export MAY write an absolute owner path into generated Load SQL. Provenance SHALL NOT contain that path. Opaque SQL with a relative file read SHALL fail with guidance instead of being rewritten.

A connection binding SHALL map an owner uid and owner connection id to a global connection id and SHALL NOT contain a secret. Auto-bind SHALL occur only when that same global connection id is already present. Otherwise the operation SHALL name the owner and the object and SHALL NOT choose a connection by display name. The consumer SHALL NOT call mapping write-back.

#### Scenario: Same relative source path

- **GIVEN** the root and the owner each have `data/products.csv`
- **WHEN** the external query that loads `data/products.csv` is used
- **THEN** the file under the owner directory is read

#### Scenario: Missing connection binding

- **WHEN** an external source needs a connection id that is not in the global store and has no binding
- **THEN** the error names the owner and the source
- **AND** no unrelated connection is used

### Requirement: Mapping storage

Seed mappings SHALL use the owner's authoritative seed rules and SHALL export one namespaced seed. Postgres-backed mappings SHALL stay relation reads and SHALL NOT copy the dictionary into the consumer project or into an inline VALUES list. A dbt `ref` mapping SHALL keep the existing preview limitation. Export SHALL NOT pretend the reference imported that dbt model.

Composite From arity, the single To column, and output-column selection SHALL survive preview and export. External mapping definitions SHALL be read-only in the consumer.

#### Scenario: Composite mapping

- **WHEN** an external mapping uses `(system_code, product_code) -> canonical_id`
- **THEN** preview and export join on both From columns and write the selected output column

#### Scenario: Export-only dbt model mapping

- **WHEN** a referenced mapping is backed only by a dbt `ref`
- **THEN** preview reports the existing unsupported limit
- **AND** export does not invent that model's SQL

### Requirement: Explorer and external nodes

The Explorer SHALL show a References section before Export. Each reference SHALL show an alias and a status of ready, update available, missing, identity mismatch, incompatible format, or invalid dependency graph. Actions SHALL be add, update, relink, open owner, and remove, limited to what the status allows.

Remove SHALL be blocked while a root step cites the reference, and SHALL list those steps. It SHALL NOT delete local queries or turn external objects into copies.

Object pickers SHALL group external objects by reference alias. Equal local and external names SHALL remain distinguishable. Adding a reference SHALL NOT place every owner object on the canvas.

The canvas SHALL show an external object only when a visible local step depends on it, as a collapsed boundary. It SHALL use an External badge and the reference alias. It SHALL NOT use the existing REF marker as the external marker. The definition SHALL NOT be editable from the consumer. Use-in-new-query SHALL create a local derivation. Create-local-copy SHALL copy that one definition, assign local ids, and leave its external dependencies external.

#### Scenario: Remove an in-use reference

- **WHEN** a reference is still cited by a local step
- **THEN** remove is blocked and names that step

#### Scenario: External query selected

- **THEN** its origin is visible, its steps cannot be edited locally, and use-in-new-query does not modify the owner

### Requirement: Diagnostics

A blocking diagnostic SHALL name the reference, the owner object, the reason, and the consumer. A missing object SHALL NOT become an empty result. The system SHALL NOT substitute a local object that happens to share the id. Schema-only resolution SHALL NOT scan source rows or list a Parquet glob merely to judge freshness.

#### Scenario: Referenced object is unavailable

- **WHEN** a used reference cannot resolve its pinned object
- **THEN** the operation reports the owner, the object, the reason, and the consumer
- **AND** it does not return an empty table

### Requirement: Deterministic export

Export SHALL emit one dbt project from the resolved selected-output closure. It SHALL NOT emit `packages.yml` entries for these references and SHALL NOT require dbt Mesh.

External queries SHALL be internal models. External seeds SHALL be namespaced seeds included in the project. Live mappings SHALL remain relation reads. Existing engine, destination, and materialization restrictions SHALL still apply.

Generated names for external objects SHALL come from a short deterministic hash of the owner uid plus kind plus object id. They SHALL NOT come from the alias, the absolute path, traversal order, or a random per-export id. Local naming SHALL stay as it is today.

`dwhq_provenance.json` SHALL record owner uid, object id, locked revision, and generated resource names for each external object in the closure. It SHALL omit credentials, absolute paths, and timestamps.

Re-export without definition changes SHALL produce the same paths, ref targets, seeds, and provenance. A diamond SHALL emit the object once. The owner's published outputs SHALL NOT add publications in the consumer.

External Postgres relations SHALL use a namespaced dbt `source()` name and SHALL keep the original database schema and table.

#### Scenario: Re-export without changes

- **WHEN** the same closure is exported twice
- **THEN** generated paths, ref targets, seeds, and provenance match

#### Scenario: External project has published marts

- **THEN** those settings do not add marts in the consumer destination

### Requirement: One operation revision

Preview, schema inference, Join Lens, and export SHALL each consume one resolved snapshot for that call. A reference update SHALL change later cache keys for the affected closure. A preview that finishes after a newer preview was requested SHALL NOT replace the newer result. The host SHALL NOT write the owner file as a side effect of preview, export, refresh, or consumer save.

#### Scenario: Owner changes during export

- **THEN** the export uses the revision captured at the start or fails
- **AND** it does not mix SQL from one revision with schemas or seeds from another

### Requirement: Execution fixture

An automated fixture SHALL:

1. Have an owner define a composite product mapping and a reusable query over a file.
2. Have a consumer reference both, add a local transformation, and survive save and reopen.
3. Show that preview and the exported dbt project agree on the fixture rows.
4. Run the files-to-DuckDB path, including seed build, without hand-edited SQL.
5. Generate the DuckDB-to-Postgres project as the existing attach route. When `DWH_PG_DSN` is set, build it and check expected keys. dbt parse or a process exit alone SHALL NOT count as data correctness.
6. Change and save the owner, show that the consumer does not pick up the change until explicit update, then show the new result.

dbt Core v1 SHALL be the executable baseline. Resolving a reference SHALL NOT require a running dbt process.

#### Scenario: Files to DuckDB

- **WHEN** the fixture consumer is previewed and the export is built with dbt
- **THEN** the preview row multiset equals the warehouse row multiset

#### Scenario: Explicit update changes the result

- **WHEN** the owner mapping is saved with a new To value and the consumer refreshes
- **THEN** preview shows the new value
- **AND** before that refresh, resolve fails because the owner file no longer matches the lock
