# ADR-0006: dbt v1 and v2 support matrix

## Status

Accepted (2026-10-24)

## Context

Exported projects must run for users on **dbt v1** (classic Core 1.x) and, inevitably, **dbt v2** (Fusion-era engine / Core 2.x). Supporting only one major forever is not acceptable.

Shipping both exporters on day one is hard; v1 export can ship first if the IR and producer API already admit a second target.

Clarify naming:

- `config-version: 2` in `dbt_project.yml` is the **project schema** version (used by dbt 1.x projects). It is **not** “dbt v2”.
- **dbt v1** ≈ dbt Core 1.x CLI users today.
- **dbt v2** ≈ dbt 2.0+ / Fusion-aligned engine (stricter language spec, new artifacts, adapter changes).

## Decision

1. **Product requirement from the start:** DWH-RS-QUERY supports export targets **dbt v1 and dbt v2**.  
2. **Implementation order:** ship **`DbtTarget::V1` first** (tested `dbt-core` 1.7–1.10 / latest 1.x + `dbt-duckdb`).  
3. **`DbtTarget::V2` is mandatory follow-up**, not optional R&D — stub/API reserved now; fill when v2 local+duckdb story is stable enough for DoD.  
4. Producer API always takes an explicit target:

   ```rust
   pub enum DbtTarget { V1, V2 }
   fn produce(..., target: DbtTarget) -> Result<String, String>;
   ```

5. Generated `dbt_project.yml` sets `require-dbt-version` appropriately, e.g.:
   - V1: `'>=1.7.0,<2.0.0'`
   - V2: `'>=2.0.0,<3.0.0'` (adjust when packaging guidance stabilizes)

6. Prefer **shared model SQL** (`ref` / `source` / staging–int–marts) across targets; diverge only in project/profile/adapter knobs and known v2 breaking configs.  
7. UI eventually exposes target (default V1 until V2 DoD is green).

## Consequences

- DoD for dbt export is **per target**. v1 DoD can land without v2 green; roadmap must show v2.  
- No hard-coded assumptions that block Fusion/v2 (e.g. obsolete top-level configs).  
- Tests: golden tree per `DbtTarget`.  
- Docs never confuse `config-version: 2` with dbt v2.
