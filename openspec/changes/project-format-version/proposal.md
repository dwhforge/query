# Proposal: project-format-version

## Why

Declare project document versioning so IR evolution is safe (ADR-0030).

## In scope

- `format_version` on Project
- migrate 0→1 (legacy soft-migrates + stamp)
- refuse newer versions
- `.bak` before overwriting older on-disk format
- fixtures + tests

## Out of scope

- IPC protocol version
- Mapping data plane / revisions store
