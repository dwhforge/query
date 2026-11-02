# Release notes — project references (ADR-0025)

- A saved project can **reference** another saved `.dwhproj.json` and use its queries and mappings without copying them into the consumer file.
- First release exports **one** self-contained dbt project (no dbt Mesh / `packages.yml`).
- Owner changes apply only after an explicit **Update** on the reference. Layout-only edits do not bump the lock.
- The consumer is **read-only** toward the owner: save never writes owner files or owner seed CSVs.
- The first save of an owner assigns an immutable `project_uid`. Re-saving an older UI that omits the field keeps the uid already on disk.
- Live Postgres / S3 / file rows are **not** frozen by the revision lock — only definitions (and authoritative seed bytes when exported).
- Cycles in the active closure fail with a readable path; unused broken references do not block unrelated local preview/export.
