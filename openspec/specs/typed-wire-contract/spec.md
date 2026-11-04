# Spec: typed-wire-contract

## Requirements

### Requirement: Rust owns MappingCheck and CheckRun IR

`Project` SHALL persist `mapping_checks` and `mapping_check_runs` as typed Rust structs, not opaque JSON values. Deserialization SHALL reject structurally invalid checks with a clear error.

#### Scenario: Round-trip check
- **GIVEN** a project JSON with a valid MappingCheck
- **WHEN** loaded and saved
- **THEN** field names and values round-trip
- **AND** an unknown required shape failure surfaces as a parse error

### Requirement: Generated TypeScript bindings stay fresh

The repository SHALL contain generated TypeScript for exported IR/wire types. CI SHALL fail if regenerating bindings produces a diff.

#### Scenario: Stale bindings
- **GIVEN** a Rust IR field rename
- **WHEN** CI runs the export freshness check without regenerating committed files
- **THEN** the job fails

### Requirement: Structured host errors

New and migrated host command failures SHALL be expressible as a typed error kind (validation, conflict, unsupported, cancelled, internal) with a message. Internal errors SHALL carry a correlation id. IPC failure replies SHALL include `error` (legacy string) and, when typed, `error_detail` (HostError JSON). The Electron bridge SHALL surface `errorDetail` to the renderer.

#### Scenario: Cancelled preview
- **GIVEN** a preview was superseded
- **WHEN** the older waiter receives the reply
- **THEN** `error_detail.kind` is `cancelled`
- **AND** the UI treats it as a quiet cancel

### Requirement: Project and KeyMap IPC request DTOs

`save_project` / `load_project` and `read_key_map` / `write_key_map` SHALL use documented Rust request DTOs exported to TypeScript. KeyMap write concurrency failures SHALL map to `HostError::conflict`.

#### Scenario: Concurrent KeyMap write
- **GIVEN** a warehouse KeyMap write refused for hash/concurrency
- **WHEN** the host returns an error
- **THEN** `error_detail.kind` is `conflict`
