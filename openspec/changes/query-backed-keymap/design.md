# Design — query-backed KeyMap

## IR

```text
KeyMapStorage::Query { query_id: String }
```

`from_columns` / `to_column` on `KeyMapDef` name result columns of that query. `entries` stays empty (stripped on save if present).

`PROJECT_FORMAT_VERSION = 2`. `migrate_v1_to_v2` = no-op stamp.

## Graph

Extend reachable deps: for each `ApplyKeyMap` on a query, if the map is `storage=query`, add edge to `query_id`. Also, validating/opening a query-backed map’s preview focuses that query id.

Cycle: refuse when map query is reachable from itself through ApplyKeyMap consumers (including “Apply inside own map query”).

## Preview / Apply

`preview_key_map_opts`: relation = compiled CTE alias of `query_id` (same as FromQuery). Compiler topo must include map queries before consumers.

Export `key_map_relations`: `{{ ref('<dbt_model_name(query)>') }}`. Collect map query ids into export set even when not in `outputs`.

## Validation

- Binding: query exists; From non-empty unique; To set; columns exist uniquely; From∩To empty.
- Rows (full execute, not sample): no NULL From part / To; unique From tuple.
- Invalid binding → block Apply + export path for that map.

## Editor

Storage kind Query → pick local query + From/To columns from describe schema. Row table RO. Refresh re-runs map query projected to From/To. No paste/add/delete/fuzzy accept.

## Revision

`keyMapRevision` for query maps hashes `query_id` + map column binding + fingerprint of map query steps (and optionally upstream ids). Not `entries`.
