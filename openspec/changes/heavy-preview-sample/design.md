# Design: heavy-preview-sample

## Host

`preview_workspace` accepts optional `rowLimit` (`u64`) and `fullPreview` (`bool`).

| Args | SQL LIMIT |
|------|-----------|
| default | 50 |
| `rowLimit: N` | N |
| `fullPreview: true` | none |

Fingerprint includes both flags so sample and full do not collide in the host preview LRU.

## Engine

`preview_workspace` keeps the sample default. `preview_workspace_limited(..., Option<u64>)` threads the limit into `GraphCompiler::to_sql_with_limit`.

## UI

- Remove the heavy early-return that cleared auto-preview.
- `isHeavyPreviewFocus` uses only the entry-count floor.
- `HeavyPreviewCache` stores sample and full results under distinct keys (`#sample` / `#full`).
- Banner + **Load full** when the focus is heavy and the grid is a sample; optional return to sample after full.
