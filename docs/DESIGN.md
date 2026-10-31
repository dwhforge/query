# DWHForge Query — Product Design

## 1. Product

**DWHForge Query** is a local desktop workbench: build a transform graph from one or many sources, preview in DuckDB, and **export a real dbt project**.

- Stack: Electron + React/TS/Tailwind + Rust (`dwh-host`) + DuckDB  
- Brand / app id: **DWHForge Query** · `com.dwhforge.query` ([ADR-0016](adr/0016-product-rename-dwhforge-query.md))  
- Repo path may still be `dwh-rs-query`  
- Raw data never leaves the machine (AI receives only schema / steps / prompt)  
- Local dir: `~/.dwhforge-query/` — `secrets.json` + `settings.json` (app defaults)

Positioning: [ADR-0001](adr/0001-product-positioning.md).

**Promise:** *Assemble and verify transforms on real data. Keep the result as SQL/dbt in your own infrastructure.*

**Licensing:** **Business Source License 1.1** ([LICENSE](../LICENSE)); Change License Apache-2.0 after four years. Docs stay English.

## 2. Horizons

| Horizon | Priority | Focus |
|---------|----------|--------|
| **v1** | Baseline | multi-source, Join/Append, preview, `dbt run`-ready export |
| **Next (now)** | Return and edit | step schema, re-export, Join investigation — [ADR-0018](adr/0018-return-and-edit.md), §9–§10 |
| **Path** | Power Query coverage | multi-query workspace = Applied Steps / Merge mental model |
| **H1→H2** | Two-way editors | visual ↔ dbt/SQL like Delphi ([ADR-0004](adr/0004-two-way-visual-text.md)); after safe re-export |
| **Later** | PQ closeness wins | richer UI transforms, profiling; dbt stays a strong exporter |

Long-term UX reference — **Power Query**, not Power BI.  
Long-term tooling reference — **two-way visual + text** (dbt and/or pure SQL), not one-shot export.

**Now:** AST is canonical; SQL/dbt are projections (read-only SQL is fine). Near-term: **per-step result schema** + deterministic re-export.  
**Later:** parse-back for a step whitelist → full round-trip with reconcile.

## 2.1 UX north star & killer feature

As a **visual** tool the bar is to **blow everyone away on usability** (not “reach PQ”, but beat it on speed-of-thought and delight).  
Conflict rule: flow UX > feature completeness. Canon: [ADR-0005](adr/0005-ux-blow-away.md).

**Ultimate UI killer feature:** the **visual pipeline / workspace editor** (multi-source graph, direct Join/Append, instant preview, one-gesture export) — [ADR-0007](adr/0007-visual-pipeline-editor-killer.md).  
Destination UX is a **graph canvas**, not a permanent list-of-forms. List+detail may be an early slice only. Next release deepens the canvas with step investigation (§9); it does not replace it.

Gates: &lt;2 minutes to Join+preview; Join in ≤3 actions; snappy preview; empty state teaches; keyboard first-class.

## 2.2 dbt version support

Export must support **dbt v1 and dbt v2** ([ADR-0006](adr/0006-dbt-version-matrix.md)).  
v1 implementation may ship first; v2 is a hard follow-up, not optional. Do not confuse YAML `config-version: 2` with dbt v2.

## 3. Persona & problem

Primary hats (often one person): **data engineer + DBA + developer** who also wears analytics-engineer for dbt models.  
Near-term beachhead: small data teams, solo engineers, consultants who regularly turn Postgres + files into dbt.  
Job: several CSV/Parquet/**Postgres** inputs → join/transform → **reproducible dbt in git**, with local DuckDB preview and inspectable SQL — not a black-box analyst canvas.

Competitive wedge: [COMPETITIVE.md](COMPETITIVE.md).

**PostgreSQL is a mandatory first-class source** — [ADR-0008](adr/0008-postgres-required.md).

## 4. Core loop

1. Connect Postgres and files; create queries (Load*)  
2. Build transforms: Join / Append / Filter / GroupBy / …  
3. Preview focus query (≤50 rows); investigate steps (§9)  
4. Export dbt → `dbt run` with no hand-edits to generated `.sql`  
5. Change a source or rule → **re-export with a clear, reviewable diff**

Steps 4–5 are the bar for *Return and edit*. If the editor only helps create v1, users stay in the IDE.

## 5. Surfaces

| Surface | Role |
|---------|------|
| **Explorer (left tree)** | Project → Connections / Sources / Queries / Export ([ADR-0009](adr/0009-project-explorer.md), [ADR-0012](adr/0012-connections.md)) |
| **Warehouse dialect + query execution** | One `target_dialect`; many source connectors; per-Query `execution` ([ADR-0014](adr/0014-query-execution-affinity.md), [ADR-0015](adr/0015-sources-vs-target-extensibility.md)) |
| **Pipeline canvas** | visual graph of queries + join edges (killer feature) |
| **Inspector** | Applied steps + Filter/Join (+ Join diagnostics, §9) |
| **Preview** | virtualized table; also diagnostic grids (§9) |
| **Export dbt** | from Explorer or toolbar |
| **AI Chat** | NL → steps (after AST / step schema stabilizes) |

**Entities (reuse, don’t invent):** Project · Source · Query · Workspace — see ADR-0009.

## 6. UX rules

- Debounce 150ms on Filter / CustomSql / Join key edits → preview  
- AI: schema + workspace JSON only, no row data  
- Product name **DWHForge Query** is the primary UI brand signal  

## 7. Out of scope

- Fuzzy merge, anti-join UI, M language  
- Full PQ transform catalog (pivot/unpivot/fill/…) — path item, not a blocker  
- Spatial UI (spatial may stay best-effort), cloud sync, auth  
- Postgres is **in scope** (required)  
- Universal SQL→AST; merge into arbitrary foreign dbt repos; incremental/snapshots/macros UI  
- Join MVP deferrals: §9 *Explicitly deferred*  
- Competitor-breadth profiling — depth on Join first  

## 8. Success

| Bar | Criterion |
|-----|-----------|
| **v1 baseline** | 2 sources + Join → Export → `dbt run` green ([SPEC.md](SPEC.md) §7) |
| **Next** | §10 DoD; 5–10 external users finish real tasks **and come back** |

See [SPEC.md](SPEC.md), [ADR-0002](adr/0002-multi-query-workspace.md), [ADR-0003](adr/0003-join-append-steps.md).

## 9. Next — Join investigation MVP

Diagnostic summaries open the relevant input rows, matching pairs or output rows in the grid. Key highlighting and grouping explain an individual Join. Full cell-level provenance across the transformation graph is outside this MVP.

### Diagnostics and grid interaction

Selecting a Join step shows the following diagnostics beside its settings:

| Diagnostic | Grid action |
|------------|-------------|
| Left / right input row counts | Open the corresponding input after all preceding transforms |
| Output row count | Open the Join result |
| Unmatched left input rows | Open left rows with no matching right row |
| Unmatched right input rows | Open right rows with no matching left row |
| Left input rows matching multiple right rows (fan-out) | Show affected keys and matching pairs, grouped by key |
| Right-key uniqueness, when expected | Show duplicate key groups and their right input rows |

- Unmatched counts describe input rows with zero matches, including rows excluded from the selected Join result. They are not counts of distinct keys or counts of NULL cells in the output.
- Fan-out counts describe left input rows with more than one right match; distinguish these from output row counts and duplicate key group counts.
- Highlight Join key columns in diagnostic grids. Provide a simple view of the relevant left/right rows and their matched result pairs; a multi-match case must make the reason for row multiplication inspectable.
- Diagnostic grids may show bounded examples; label the sample limit separately from the count. State whether a check covers a sample or the full input. A clean sample is not proof that the full input satisfies an expectation.
- Scope all checks to the actual inputs of this Join, after preceding transforms, rather than the original physical tables.

### Expectations and exported checks

- An expectation is an explicit persisted condition, such as a unique right key for a many-to-one Join. A diagnostic observation alone does not create it.
- Display violations beside the Join and link to the offending rows in the grid.
- Export the corresponding dbt check against the right query output consumed by this Join. Preserve the expectation and deterministic YAML across re-export.
- A single-column right key can use a generic `unique` test. Composite keys require a combination-uniqueness check; separate per-column `unique` tests do not express the same expectation.

### Explicitly deferred

Cell-level lineage through arbitrary SQL, calculations and aggregation; a universal provenance browser; and rich profiling of every column are not acceptance criteria for Join investigation MVP. An optional AI narrator over Join Lens facts is deferred ([ADR-0019](adr/0019-join-lens-ai-narrator.md)).

### Key mapping (fix keys before Join)

Unmatched / near-miss keys are fixed with explicit steps, not fuzzy Join ON ([ADR-0020](adr/0020-join-key-mapping.md)):

- **Near-miss** → `NormalizeKey` (trim/case/spaces/zeros) on Left / Right / Both
- **Aliases** → `KeyMap` From→To table + `ApplyKeyMap`; export as `seeds/map_*.csv` (table after `dbt seed`). After first export the seed is source of truth (sync back into the editor).
- EmptyHero includes a virtual Key mapping playground; Help → KeyMap labs cover hub/crosswalk/dual/codes/hop, seed/source/ref, and PG routes (`scripts/examples/`, `dwh_tests`). Classic F&B: `dirty_join` / `daily_pnl` / `monthly_pnl`. Patterns: [keymap-workflows.md](keymap-workflows.md).

## 10. Next — Definition of Done (*Return and edit*)

Decisions: [ADR-0018](adr/0018-return-and-edit.md).  
Build order: **step schema → portable emit → re-export → e2e**; then Join diagnostics (§9) and expectations.  
**External users in parallel** — first trials after schema → export → e2e (do not wait for full diagnostics).  
Do not expand the transform catalog until A–C are green.

### A — Step schema & chains

- [x] Schema is a **derived** compile result (Workspace + source metadata), not a second editable truth — `schema.rs`  
- [x] Propagation needs **explicit output names**; raw expressions / unknown aliases → unknown schema  
- [x] `Load*` / `FromQuery` seed when metadata exists; unknown stays loud downstream  
- [x] Ambiguous ASCII-fold names within one relation fail loud  
- [x] When schema is known, Postgres Append/Rename use portable aligned SQL  
- [x] Wire Load* seeds from catalog/describe into export UI path (`collect_load_seeds` + App `connections`)  
- [ ] Chain **source → Rename → Append** end-to-end `dbt run` on **Postgres** target (optional / manual; DuckDB e2e covers Rename→Append)  

### B — Stable re-export ([ADR-0018](adr/0018-return-and-edit.md) §3)

- [x] Manifest of generator-owned files + content hashes (`.dwhforge-export.json`)  
- [x] Hand-edit / hash mismatch → **refuse before write**; no partial tree on failure  
- [x] Stale owned models removed only after conflict check passes  
- [x] Name stability when **focus** changes or an **unrelated** query is added  
- [x] Identical workspace → trivial diff (necessary, not sufficient)  
- [x] UI/docs: offline `dbt parse` ≠ `dbt run` ([ADR-0017](adr/0017-export-offline-dbt-parse.md); Help + README)  

### C — End-to-end correctness

- [x] Fixture (two CSV + Rename→Append) → export → `dbt run` (DuckDB) with no SQL hand-edits — `dwh-engine` `export_e2e`  
- [x] Compare preview vs warehouse result on the fixture  
- [x] Append/Rename semantics aligned under ASCII fold policy  
- [ ] Postgres-target e2e automated (document manual path; not claimed in CI)  

### D — Join diagnostics + expectations

- [x] §9 diagnostics in UI (counts, unmatched, fan-out, samples); must not block editing — `join_diagnostics` + Join inspector panel  
- [ ] Persist ≥1 Join expectation; export dbt test(s); survive re-export  

### E — Demand (process, parallel)

- [ ] Recruit external tasks while A–C are built  
- [ ] First trials after A–C green; 5–10 tasks; track return within ~1 week  

