# Proposal: project-relative-load-paths

## Why

Absolute Load/Source file paths make a `.dwhproj.json` non-portable. Teams want a project-folder layout (data beside the document) with an **explicit** absolute vs relative flag that works across Windows and Linux.

## In scope

- `path_kind: absolute | relative` on LoadCsv / LoadParquet / LoadDuckdb (file path) and file `SourceDef`
- Relative base = project file directory; relative storage uses `/`
- Cross-platform absolute heuristic for migration only; runtime trusts `path_kind`
- Relativize under project dir on Save; resolve relative on preview/export/execute
- `format_version` 5 + migrate; ADR-0043
- Step editor shows kind; Change file prefers relative when project is saved

## Out of scope

- Rewriting opaque SQL file reads into relative form
- Syncing absolute paths across OS when they are not under the project tree
- Changing reference `locator` rules (already relative per ADR-0025)
