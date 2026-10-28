# Proposal: Return-and-edit foundation (through e2e)

## Why

ADR-0018 (*Return and edit*) requires a trustworthy loop: transform → export → change → re-export with a clear diff, with preview/export column semantics aligned. Partial work already landed (`schema.rs`, portable Append/Rename when seeds exist). Without wiring seeds into real export, a re-export contract, and an e2e check, users still cannot rely on the product for regular edits.

## What changes

Complete the **foundation slice** of ADR-0018 — stop **before** Join investigation MVP ([DESIGN.md](../../../docs/DESIGN.md) §9).

| In scope | Out of scope (later) |
|----------|----------------------|
| Load* column **seeds** from Postgres catalog / file describe into export & dbt model emit | Join diagnostics UI (§9) |
| **Safe re-export**: manifest + content hashes; refuse conflicts before write; no partial tree | Expectations → dbt tests |
| **e2e**: fixture → export → `dbt run` (or documented CI equivalent) + result check vs preview | H1 SQL parse-back (ADR-0004) |
| Name stability when focus changes / unrelated query added | Foreign dbt repo import |
| Docs: DESIGN §10 A–C checklist progress | Transform catalog expansion |

## Capabilities

1. **step-schema** — derived per-step schemas; seeds for Load*; portable emit when known  
2. **safe-re-export** — generator-owned manifest, hashes, conflict refuse, stale cleanup, atomicity  
3. **export-e2e** — supported fixture path proving export + warehouse run + semantic match  

## Success

- `source → Rename → Append` (with real PG/file metadata) exports portable SQL and runs on target without hand-edits.  
- Second export of an unchanged project is a trivial diff; hand-edited owned files block export before any write.  
- External-user trials may start after this change lands (per ADR-0018 §5) — Join diagnostics not required for first probe.

## Non-goals

Join grid diagnostics, expectation persistence, two-way text, dbt v2 producer, expanding transform catalog.

## References

- [ADR-0018](../../../docs/adr/0018-return-and-edit.md)  
- [DESIGN.md](../../../docs/DESIGN.md) §10 A–C  
- Existing emit/schema code in `crates/dwh-pipeline`  
