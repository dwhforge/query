# Competitive landscape & positioning

Canon name: **DWHForge Query**. Related: [ADR-0001](adr/0001-product-positioning.md), [ADR-0016](adr/0016-product-rename-dwhforge-query.md), [DESIGN.md](DESIGN.md).

Snapshot date: 2026-10. Treat names/features as moving targets; re-check before GTM claims.

---

## 1. Category

We sit at the intersection of:

1. **Local desktop workbench** (data stays on-device)
2. **Visual multi-source transform** (Power Query *mental model*, not M)
3. **Developer-grade IR → real artifacts** (runnable **dbt v1/v2** project, inspectable SQL)

We are **not**: a BI dashboard, a warehouse SaaS, a 300-connector ETL platform, or “another DuckDB SQL IDE”.

---

## 2. Landscape matrix

| Tool | Closest overlap | Engine / host | dbt story | Dev/DBA signals | Gap vs us |
|------|-----------------|---------------|-----------|-----------------|-----------|
| **[Duckle](https://duckle.org/)** | Strongest peer: canvas + DuckDB + SQL per node + local | DuckDB; Tauri-class desktop; runner/schedule | **Runs** dbt on DuckDB inside studio | Git-friendly workspace files; Plan/SQL tabs; lineage | Full ETL platform (380+ components, sinks, DQ, deploy). We are thinner: **author → export dbt as the product**, not operate pipelines |
| **[Flowfile](https://flowfile.io/)** | Visual + two-way with code | Polars; desktop/Docker | Weak / not first-class | Canvas↔Python notebook; YAML flows | Code target is Polars/Python, not dbt project layout |
| **[dbt Canvas](https://docs.getdbt.com/docs/cloud/canvas)** | Visual → real dbt models | Cloud warehouse | Native (enterprise) | Git-versioned models; Copilot | Cloud Enterprise only; not local DuckDB-first multi-file prep |
| **[Prophecy](https://www.prophecy.io/)** | Two-way visual↔code | Spark / cloud | Secondary | Git-backed executable code | Cloud/Spark; not local DuckDB + Postgres prep → dbt |
| **[Kuwala](https://github.com/kuwala-io/kuwala)** | Nodes + dbt transforms | Warehouse / Airbyte-ish | Built-in transforms | OSS graph | Less “local PQ workbench”; infra-heavy |
| **Power Query** | UX north star (Applied Steps / Merge) | Excel / Fabric | None | Low (analyst tool) | No dbt export; not a DE CLI/project loop |
| **Alteryx / EasyMorph / KNIME / Tableau Prep** | Visual prep | Various desktop | Rare / none | Mixed; often analyst-facing | Heavy UI; weak “ship a dbt repo” story |
| **DuckLocal / DearSQL / omni-sql / DuckQuery** | Local DuckDB | DuckDB | None | SQL IDE comfort | No Project/Source/Query graph + dbt producer |
| **ForgeLyte** | Browser visual ETL | DuckDB-WASM | Weak | Low | Not desktop Project + first-class dbt export |
| **dbt Core / SQLMesh** | Destination artifacts | CLI | Native | Highest (code-first) | No killer visual authoring |

### Closest peers (summary)

| Peer | Steal / watch | Do not become |
|------|---------------|---------------|
| Duckle | Canvas polish, SQL-on-node honesty, local-first trust | Another mega-ETL + runner product |
| Flowfile | Two-way visual↔text UX | Polars-only Python exporter as north star |
| dbt Canvas | “Output is real dbt models” credibility | Cloud-only / enterprise-gated dependency |
| Power Query | Speed-of-thought Applied Steps / Merge | Analyst-only black box with no repo |

---

## 3. Wedge (why we exist)

Almost no product owns **all five**:

1. Desktop, **local-first** (Postgres + files)
2. Ultimate **visual** Project / Sources / Queries / canvas
3. **AST-as-IR** (not opaque UI state)
4. Primary shippable artifact = **real dbt project** (`sources.yml`, staging/intermediate/marts, `require-dbt-version` for **v1 and v2**)
5. Roadmap to **two-way** visual ↔ dbt/SQL (Delphi-like), not one-shot dump

**One-liner (internal):**  
*Power Query speed for people who ship dbt — local, inspectable, git-ready.*

**One-liner (external, DE-facing):**  
*Local visual workbench that compiles multi-source transforms into a runnable dbt project you can own in git.*

---

## 4. Positioning: push harder as DE + DBA + developer tool

Current docs lean “analytics engineer + dbt help”. That is correct for v1 DoD, but the **brand surface** can read softer (ETL canvas for analysts) unless we deliberately show **toolchain** cues.

Target persona stack (same human often wears all three):

| Hat | Job-to-be-done | What must feel true in the product |
|-----|----------------|------------------------------------|
| **Data engineer** | Ship reproducible transforms | Export is a real repo layout; `dbt run` / CI without hand-edits; clear staging → int → marts |
| **DBA** | Trust Postgres + types + safety | First-class Postgres; connection hygiene; schema/describe; explainable SQL; no silent type coercion |
| **Developer** | Live in IDE / git / keyboard | Project-on-disk; VS Code–like Explorer; generated SQL readable; CLI parity; diffs that make sense |

### 4.1 Product signals that “feel like a tool”, not a toy

Prioritize these in UI, docs, and roadmap messaging (many are already seeded in SPEC/ADRs):

| Signal | Why it hits DE/DBA/dev | Concrete direction |
|--------|------------------------|--------------------|
| **Artifacts over screenshots** | DE | Toolbar primary CTA = *Export dbt*; show tree of generated files; open folder / copy path |
| **SQL is honest** | DE + DBA | Always-available compiled SQL (per step / per query); copy; later explain |
| **Project = folder** | Dev | Persist `project.json` + optional sync with export dir; git-friendly paths |
| **Sources as contracts** | DE + DBA | Explorer Sources mirror `sources.yml` names; Postgres required; describe columns / types |
| **CLI twin** | Dev | Keep `dwh-preview` / future `dwh export` as first-class; same IR as UI |
| **Keyboard + Explorer** | Dev | VS Code muscle memory (already ADR-0009); shortcuts for Join / Preview / Export |
| **Hard fails, not magic** | DBA + Dev | Postgres extension missing → actionable error ([ADR-0008](adr/0008-postgres-required.md)); cycles → compile error |
| **Version matrix** | DE | Explicit dbt **v1 \| v2** target in Export ([ADR-0006](adr/0006-dbt-version-matrix.md)) — rare and “serious” |
| **Diffable output** | Dev | Stable model names; deterministic SQL formatting; no random IDs in filenames |
| **Two-way later** | Dev | Market as Delphi for dbt/SQL — developers keep owning text |

### 4.2 Language & branding (how to “выпятить”)

Use these words in README hero, empty state, and Export dialog:

- Prefer: **workbench**, **IR / AST**, **compile**, **project**, **sources**, **models**, **profiles**, **ref/source**, **git**, **CI**, **CLI**, **schema**, **Postgres**
- Avoid as primary: “no-code”, “drag-and-drop magic”, “for everyone”, “AI data platform”
- Visual is the **killer UX**, not the category name — category is **dbt authoring workbench** / **local transform compiler**

Suggested hero line options:

1. *Compile multi-source pipelines into dbt — locally, on DuckDB, with Postgres.*  
2. *A developer workbench for dbt: visual when you want speed, SQL when you need proof.*  
3. *From Postgres + files to a clean dbt project — without leaving your machine.*

### 4.3 What not to copy from peers

| Temptation | Risk |
|------------|------|
| Match Duckle’s 380 components / sinks / scheduler | Dilutes “dbt export is the product”; becomes platform |
| Lead with AI chat | Softens DE/DBA trust; keep AI after AST + SQL honesty |
| Analyst-only Applied Steps with hidden SQL | Loses developer identity |
| Cloud sync / SaaS warehouse first | Breaks local-first + DBA trust story |

### 4.4 Competitive posture (talk tracks)

| Audience | Vs Duckle | Vs dbt Canvas | Vs Power Query |
|----------|-----------|---------------|----------------|
| DE | “We generate the dbt you already run in CI — we don’t replace your orchestrator.” | “Same destination models, but local files + DuckDB preview before the warehouse bill.” | “PQ speed, but the output is a repo, not a workbook.” |
| DBA | “Postgres is a first-class source with hard requirements, not a checkbox.” | “Credentials and data stay local until *you* point dbt at a profile.” | “You can read every CTE we compile.” |
| Developer | “Smaller surface, IR you can test in Rust, CLI parity.” | “No enterprise gate to sketch a join.” | “Keyboard + Explorer + diffable SQL/dbt.” |

---

## 5. Implications for roadmap (positioning-driven)

Order that reinforces DE/DBA/dev (without rewriting v1 DoD):

1. **Honest SQL panel** + copy (even if read-only) — already on path.  
2. **`project.json` on disk** + Export shows file tree.  
3. **Postgres describe / schema inspector** in Sources.  
4. **CLI `export`** mirroring UI `export_dbt`.  
5. **dbt v2 producer** (credibility of version matrix).  
6. Then richer PQ transforms / two-way parse-back — still under “developer owns the text”.

Success metric stays: `dbt run` with no hand-edits — that *is* the DE proof. Marketing should say that out loud.

---

## 6. Doc links

| Doc | Role |
|-----|------|
| [DESIGN.md](DESIGN.md) | Horizons, UX killer, persona |
| [SPEC.md](SPEC.md) | Contracts / DoD |
| [ADR-0001](adr/0001-product-positioning.md) | dbt-first, PQ-path |
| [ADR-0005](adr/0005-ux-blow-away.md) | UX bar |
| [ADR-0007](adr/0007-visual-pipeline-editor-killer.md) | Visual as killer feature |
| [ADR-0008](adr/0008-postgres-required.md) | Postgres mandate |
| [ADR-0009](adr/0009-project-explorer.md) | Project / Explorer |
