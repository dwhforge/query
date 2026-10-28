# Spec Delta: export-e2e

## Purpose

Prove the foundation loop end-to-end: multi-source transform → export → `dbt run` without hand-editing generated SQL, with result aligned to preview semantics for the fixture.

## ADDED Requirements

### Requirement: Runnable export without SQL hand-edits

For the supported e2e fixture, Export SHALL produce a dbt project that completes `dbt run` successfully using the generated `profiles` without modifying generated `.sql` files by hand.

#### Scenario: Fixture green run
- **GIVEN** the documented foundation fixture (multi-source + Rename/Append or Join as specified in tasks)
- **WHEN** the project is exported and `dbt run` is executed with `--project-dir` / `--profiles-dir` at the export root
- **THEN** the run exits successfully
- **AND** no generated model SQL was edited after export

### Requirement: Preview vs warehouse result check

The e2e suite SHALL compare the focus query’s preview result (or an equivalent local computation) to the warehouse table/view produced by `dbt run` for that focus model, using row multiset or checksum equality on the fixture data.

#### Scenario: Semantic match on fixture
- **WHEN** e2e completes `dbt run` on the fixture
- **THEN** the focus mart/table contents match the preview expectation for that workspace
- **AND** Append/Rename column alignment follows ASCII-fold BY-NAME policy (no positional mis-union)

### Requirement: Offline parse remains author gate only

Export MAY still run offline `dbt parse` as an author check. e2e correctness SHALL NOT treat parse-alone as sufficient proof of data correctness.

#### Scenario: Parse vs run
- **WHEN** documenting or asserting export quality
- **THEN** tests distinguish `dbt parse` success from `dbt run` + data compare

### Requirement: Documented Postgres path

If CI runs only DuckDB-target e2e, the repository SHALL document how to run the Postgres-target variant manually or in optional CI, without claiming it is covered when it is not.

#### Scenario: Honest CI matrix
- **WHEN** a contributor reads e2e docs
- **THEN** they can tell which dialects/fixtures are automated vs optional
