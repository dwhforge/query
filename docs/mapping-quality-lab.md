# Mapping quality lab (prototype)

Open **Help → Mapping labs → Mapping quality — 100K products · overview prototype**.
The app generates offline CSVs in `~/.dwhforge-query/demos/mapping-quality-v1/`
and opens them as an ordinary project (same preview / KeyMap rules as any other).
No Python, network request, Postgres or LLM is required. Reopening reuses these
files; an incomplete cache reports an error rather than silently replacing it.

The workspace contains 100000 commercial positions, 2400 canonical products and
95000 seed links. It opens the **Mapping quality · Prototype** tab. Graph Data
auto-previews a `LIMIT 50` sample; **Load full** runs without an output LIMIT
when the focus Applies the large seed map ([ADR-0041](adr/0041-heavy-preview-sample.md)).

## What to discover

- **Family view:** find the off-diagonal Sulfur → Urea flow. Compare count with
  share-of-source-group; a global percentage can hide a local systematic issue.
- **Family + grade:** find NPK B → NPK A. Coverage did not preserve this distinction.
- **Decision basis:** see that accepted fuzzy links can have a close alternative.
  These method/score/gap fields are declared synthetic annotations, not outputs
  from a matcher that ran during loading.
- **Concentration:** inspect the largest Ammonia target. It absorbs 10000 extra
  positions and combines source grades, while legitimate packaging convergence
  appears elsewhere. Concentration alone does not mean the mapping is wrong.
- **Revenue exposure:** synthetic revenue changes the weighting, not the inferred
  probability of an error.

Select a matrix cell or target, then **Inspect sample keys in Join Lens**. The lab
seeds a durable **MappingCheck** ([ADR-0027](adr/0027-mapping-quality-checks.md)):
cohort predicate on the check, ephemeral TEMP query for Lens, optional allow-difference
on the check (does not change links), and staged remap confirm locked to a map
revision. Recalculate records a **CheckRun** with attributed Δ. Later Inspects replace
the same TEMP node. Neither selecting a cell nor allowing a difference edits the
KeyMap — only Confirm into KeyMap / existing Save·Apply does.

## Scope and limits

The SQL projections scan all source rows and use the actual applied seed mapping.
The browser receives 32 aggregate groups (for the unedited fixture), the top 12
targets and bounded samples. A window total prevents a truncated preview from
being presented as a whole-dataset overview. Sample rows are illustrative, not
proof that every member of a region is correct.

This prototype is configured for the lab's named queries and attributes, not an
automatic profiler for arbitrary mappings. It preserves current 1/N → 1 mapping
semantics. There is no new LLM integration or drag-and-drop editor.

The current application still serializes the full seed map in the workspace and
compiles seed rows into SQL. Chart aggregation bounds displayed data, not this
existing transport cost. Native integration should be measured on the user's
machine before making performance guarantees.

The color strips use a primary-signal partition: no catalog partner, different
family, different grade, close alternative, similarity basis, aligned attributes
(in that order). They are not independent overlapping risk counts. Decision
annotations describe the fixture's original choices, not new matcher execution.

Full native acceptance: `cargo test -p dwh-host --test mapping_quality`.
