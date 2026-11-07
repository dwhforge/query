# Design: project-relative-load-paths

## IR

```json
{ "type": "LoadCsv", "payload": { "path": "data/crm.csv", "path_kind": "relative" } }
{ "type": "LoadCsv", "payload": { "path": "/abs/crm.csv", "path_kind": "absolute" } }
```

`FilePathKind` serde: `snake_case` (`absolute` | `relative`). Default when missing: `absolute` (legacy).

## Modules

- `dwh_pipeline::file_path` — classify (migrate), portable relative string, resolve, relativize under project dir, walk Project/Workspace/Sources
- Save (`save_project_with_secrets`) calls `relativize_project_file_paths` before disk JSON
- `lower_for_operation` always runs `resolve_project_file_paths` when `project_file` is set (local + xref); relative without project file → error

## Migration v4→v5

Stamp `path_kind` on every file Load payload and file Source using cross-platform looks-absolute; bump `PROJECT_FORMAT_VERSION` to 5.
