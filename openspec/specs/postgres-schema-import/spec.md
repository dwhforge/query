# postgres-schema-import

## ADDED Requirements

### Requirement: Selected relations become live queries

The import SHALL create one Source and one `LoadPostgres` query per selected relation, bound to the existing connection id, with no invented transforms and no row bodies.

#### Scenario: Ordinary table is not a mapping

- **WHEN** the user imports `public.notes` and the name matches no prefix and has no force decision
- **THEN** the project gains a query and a source for that relation and no KeyMap

#### Scenario: Rescan does not duplicate

- **WHEN** the same relation is committed again
- **THEN** the existing source, query, and map ids are reused

### Requirement: Mapping candidates follow an explicit decision order

A relation SHALL be a mapping candidate only when a saved force decision says so, or when no exclude decision exists and the relation name starts with a configured literal prefix while its schema is in the rule schema list. `_` in a prefix SHALL be literal.

#### Scenario: Prefixes do not act as wildcards

- **WHEN** prefixes are `map_` and `_map_`
- **THEN** `map_codes` and `_map_supplier_products` are candidates and `my_map_codes` and `notes` are not

#### Scenario: Exclude survives rescan

- **WHEN** the user marks a prefixed relation exclude and later scans again
- **THEN** the relation stays an ordinary query

### Requirement: Bindings are confirmed and disjoint

The import SHALL NOT assign a service primary key `id` as From automatically. Confirmed From order, outputs, attrs, and temporal columns SHALL be disjoint. Missing or ambiguous columns SHALL NOT produce a ready map. NULL, duplicate From, and overlapping ranges SHALL be recorded separately and SHALL NOT disable Apply uniqueness guards.

#### Scenario: Composite From and multi-output round-trip

- **WHEN** a confirmed map is saved and the project is loaded again
- **THEN** From order and every output column are unchanged and `entries` is empty

#### Scenario: View mapping is not writable

- **WHEN** the relation is a view or materialized view
- **THEN** it is imported as a read query and write-back is not offered

### Requirement: Commit is one fold

The wizard SHALL keep a session draft until commit. Commit SHALL refuse a stale project fingerprint, refuse Save-in-flight binding changes, and require discard confirmation for dirty binding edits. Cancel and a failed commit SHALL leave the project unchanged. A repeated commit token SHALL NOT create a second set of objects. Commit SHALL NOT run DDL, DML, or materialized-view refresh, and SHALL NOT store credentials or relation rows in import metadata.

#### Scenario: Working query opens Join Lens

- **WHEN** the user confirms a working query with a map and a Join
- **THEN** the project contains that query with the confirmed bindings and the existing Join Lens is opened without creating a MappingCheck

#### Scenario: Dropped column stays broken

- **WHEN** a confirmed column disappears
- **THEN** the map and query remain, the binding is broken, and no similar column name replaces it
