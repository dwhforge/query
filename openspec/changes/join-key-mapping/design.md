# Design: Join Key Mapping

## IR

```text
KeyMapDef { id, name, entries: [{ from, to }] }   // on Workspace.key_maps
NormalizeKey { columns, ops: [Trim|Lower|Upper|CollapseSpace|LtrimZeros] }
ApplyKeyMap { column, map_id, entries }            // entries = emit snapshot
```

- `from` unique after trim; empty `to` rejected at validate/save.
- NormalizeKey / ApplyKeyMap overwrite the column in place on the query that owns the field (before Join on host, or end of right query).

## Emit + SoT

- Mapping is always a **table** (`from`, `to`). Default materialization: `seeds/map_*.csv` → `dbt seed` → WH table. CSV is git form of the table, not a different product concept. KeyMap may later bind to an existing `source`/`ref` table instead of generating a seed.
- Preview (DuckDB): NormalizeKey → overwrite; ApplyKeyMap → VALUES/temp or read synced seed rows + COALESCE.
- dbt: ApplyKeyMap → `LEFT JOIN {{ ref('map_<id>') }}` (or bound relation).
- **SoT:** pre-export → KeyMap in project; **after first export** → seed file is SoT; load/sync seed → KeyMap (+ ApplyKeyMap snapshots) on open/refresh. Safe-re-export hashes apply to map seeds.
- Postgres emit requires `prev_columns` for overwrite projection (no EXCLUDE).

## Near-miss

For each ops × {Left, Right, Both}: count distinct key overlap on full Join inputs; keep `delta_matches > 0`. Sample newly converging pairs. UI Apply inserts NormalizeKey on the chosen side(s) immediately before the Join (host) or as last step on right.

## Apply sides

- Left: insert on host query before Join index.
- Right: append (or update) on right query.
- Both: both of the above with the same map_id / ops.
- Re-apply: replace existing step matching `(column, map_id)` or same NormalizeKey columns+ops slot before Join.

## UI entry points

Lens Probe/Linked, blame `no_partner`, diagnostics unmatched samples, History step click, Explorer KeyMaps list, paste TSV/CSV.
