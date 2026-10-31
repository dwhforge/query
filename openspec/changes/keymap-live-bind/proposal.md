# Proposal: KeyMap live Postgres bind (wizard + scale)

## Why

Binding a KeyMap to a live Postgres table must support real mapping tables (From/To under other names, extra editable columns) and **100K-class** dictionaries without stuffing the project JSON or VALUES CTEs ([ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)).

## What changes

| In scope | Out of scope |
|----------|--------------|
| Bind wizard: connection, table, From/To, editable column whitelist | Writable parquet/csv SoT |
| `editable_columns` + `KeyMapEntry.attrs` | Attrs in ApplyKeyMap / Join ON |
| Dirty-delta Save; batched upsert-by-from | Full DELETE+INSERT wipe of source tables |
| Paged/filtered WH read; preview ATTACH join for source | Streaming seed/`entries` UI at 100K |
| ADR-0022 | File import (see docs/plans) |

## Capabilities

1. **keymap-live-bind** — wizard, IR attrs, delta write, paged read, ATTACH preview

## Success

- User binds an existing PG table with non-`from`/`to` column names and edits extra whitelisted columns.
- Save updates only dirty From-keys; serial/unselected columns survive.
- Preview of ApplyKeyMap against a large source map does not embed the full dictionary as VALUES.
- Project file does not grow with the full WH dictionary for `storage=source`.

## References

- [ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)
- [ADR-0020](../../../docs/adr/0020-join-key-mapping.md)
