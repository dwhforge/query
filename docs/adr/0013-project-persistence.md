# ADR-0013: Project persistence (`*.dwhproj.json`)

## Status

Accepted (2026-10-25)

## Context

ADR-0009 deferred save/load. Connections (ADR-0012), Sources, and Workspace must round-trip as one document for DE workflows and offline use.

## Decision

1. Canonical on-disk document: pretty-printed JSON matching `dwh_pipeline::Project`.  
2. Suggested extension: `.dwhproj.json` (still valid JSON).  
3. Tauri commands: `save_project(path, project)`, `load_project(path)`.  
4. UI: **Save** / **Open** (+ Ctrl/Cmd+S / Ctrl/Cmd+O).  
5. `root_path` updated on save/load.  
6. Secrets may still be inside the file until a vault lands — same warning as ADR-0012.

## Consequences

- Sample load does not wipe an explicit saved path unless replaced by Open.  
- Export dbt remains a separate artifact tree; Project file is the authoring IR.
