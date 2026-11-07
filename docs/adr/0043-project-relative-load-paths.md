# ADR-0043 — Project-relative Load paths with explicit kind

## Status

**Accepted** (2026-11-07) — implemented; contract merged to
[`openspec/specs/project-relative-load-paths/`](../../openspec/specs/project-relative-load-paths/).

## Context

A `.dwhproj.json` is becoming a “full” project tree (data next to the document), like a .NET / IDE project. Today `LoadCsv` / `LoadParquet` / local `LoadDuckdb` and `SourceDef.path` store whatever the file picker returns — usually an **absolute** OS path. That breaks when the folder moves or is cloned on another machine.

[ADR-0025](0025-project-references.md) already resolves **relative** Load paths for *referenced* owners against the owner project directory. The open project itself does not yet persist portable relatives, and path kind is inferred from string shape — which is wrong across Windows vs Linux (`C:\…` is not `Path::is_absolute` on Linux).

## Decision

1. **Explicit kind, never infer at runtime.** Every file Load payload and every `SourceDef` with a file `path` carries:
   - `path: string` — the stored locator
   - `path_kind: "absolute" | "relative"` — required semantics  
   Missing `path_kind` on load (legacy) is filled by a one-shot migration heuristic; after that the flag is authoritative even if the string “looks” otherwise.

2. **Relative base = directory of the project file** (`root_path`’s parent), same rule as reference locators ([ADR-0025](0025-project-references.md)). Relative storage uses **forward slashes** only (`data/crm.csv`). Absolute storage keeps the native OS form for that machine.

3. **Cross-platform absolute detection (migration / tooling only):**  
   - `s3://…` → treat as absolute (opaque URI; not project-relative)  
   - leading `/` → absolute (Unix)  
   - leading `\\` → absolute (UNC)  
   - `X:/` or `X:\` → absolute (Windows drive)  
   Do **not** use host `Path::is_absolute` alone when classifying foreign paths.

4. **Save:** when writing the project file, any **absolute** Load/Source path that lies under the project directory is rewritten to **relative** + `path_kind: relative`. Paths outside the tree, remote URIs, and connection-backed remote Parquet stay **absolute** (or remote). Unsaved projects (no project file yet) keep absolute paths until first Save.

5. **Execute / export / preview:** resolve `relative` against the project file directory to a host-absolute path before DuckDB/SQL. If the operation needs a relative path and `project_file` is missing → clear error (“Save the project first”). Ephemeral resolved copies do not rewrite the in-memory authoring IR unless Save runs.

6. **`format_version` → 5.** Migration `v4 → v5` stamps `path_kind` on LoadCsv / LoadParquet / LoadDuckdb (when path set) and file Sources via the cross-platform heuristic. Stamp-only for apps that must refuse older readers? No — older apps without the field still default absolute via serde; bump forces awareness and backup ([ADR-0030](0030-project-format-version.md)).

7. **UI:** Step editor shows path + kind; **Change file…** picks a file; after Save (or immediately if project already saved) prefers relative when under the project dir. Do not invent a second path language in raw SQL ([ADR-0025](0025-project-references.md) opaque SQL rule unchanged).

## Consequences

- Cloned / moved project folders keep working when data lives beside the `.dwhproj.json`.
- Opening a Windows absolute path on Linux stays broken (expected); relative paths are the portable form.
- Hive / source matching continues to key on the stored `path` string; Save keeps Load and Source in sync when relativizing.

## References

- [ADR-0013](0013-project-persistence.md), [ADR-0025](0025-project-references.md), [ADR-0030](0030-project-format-version.md)
