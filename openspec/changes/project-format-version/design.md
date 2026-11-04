# Design — project-format-version

## Constants

```rust
pub const PROJECT_FORMAT_VERSION: u32 = 1;
```

## Load

`Project::from_json` → parse Value → `migrate_project_document(&mut v)?` → typed deserialize.

`migrate_project_document`:
1. read version (default 0)
2. err if `> PROJECT_FORMAT_VERSION`
3. while ver < CURRENT: run step, ver += 1
4. write `format_version: CURRENT`

v0→v1 = today's `migrate_project_value` body (engine/destination/outputs).

## Save

`save_project_with_secrets`: if path exists, peek `format_version` (default 0); if `< CURRENT`, `fs::copy(path, path + ".bak")` then write.
