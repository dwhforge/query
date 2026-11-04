# Mapping quality prototype — 100K Help lab

This is a NEW, independent patch based on feature/references commit
2cf0150ba1f304e069cd673d9dac0799677ee755. It replaces the direction of the rejected
visual-card editor. Do NOT stack it on visual-keymap-editor.patch.

## Look first

Open mapping-quality-preview.html in a browser. It is self-contained and needs
no server, package installation or network. It displays aggregates actually
computed in DuckDB 2.0.0 over the 100K lab. Refresh reloads that saved snapshot;
Inspect displays its exact sample keys. The desktop implementation opens the real
Join Lens instead. The preview is not a live backend or an LLM demonstration.

## Apply to DWHForge Query

From a clean repository checkout (replace /path/to with the extracted folder):

```sh
git switch -c feature/mapping-quality-prototype 2cf0150ba1f304e069cd673d9dac0799677ee755
git apply --check /path/to/mapping-quality-prototype.patch
git apply /path/to/mapping-quality-prototype.patch
npm run build
npm run electron:dev
```

Use your existing repository dependency/runtime installation. If applying to a
newer commit, reconcile differences first; do not ignore --check failures.

Open Help -> Mapping labs -> Mapping quality — 100K products · overview prototype.
The app generates and caches its data in ~/.dwhforge-query/demos/mapping-quality-v1.
No manual CSV generation, Python, LLM or Postgres is needed to load the demo.

## Explore

1. Select Sulfur -> Urea. There are 10000 positions: 10% of all input, but 57.1%
   of the Sulfur source group. Switch count to share-of-source-group.
2. Switch to Family + grade. NPK B -> NPK A exposes a distinction lost despite
   high coverage.
3. Switch to Decision basis. Declared fuzzy decisions include 10000 accepted
   links with close alternatives. These are fixture annotations, not live scores.
4. Select the largest concentrated target (P2-A-000): 10017 positions, two source
   grades and four packaging variants. High concentration is evidence, not a verdict.
5. Inspect sample keys in Join Lens. Desktop creates an ordinary query over at
   most 24 exact keys. Return via the Mapping quality workspace tab.

The original Join Lens and existing mapping editor are unchanged. There is no
second draft store or drag-and-drop mapping editor in this patch.

## Scale and verification

- 100000 commercial rows, 2400 canonical products, 95000 unique seed links.
- True full-input aggregate SQL produces 32 matrix groups and 12 target groups.
- Expected primary signals: 45000 aligned; 20000 grade differences; 10000 family
  differences; 10000 close alternatives; 10000 similarity basis; 5000 unmapped.
- Primary signals are exclusive by documented priority, not independent risk counts.
- The real Rust pipeline compiler emitted the SQL that was executed in DuckDB 2.0.0.
  With 4 threads and a 1GB memory limit in this environment, each full projection
  took about 3 seconds; this is not a forecast for your machine or native app latency.
- New generator/workspace tests passed against the actual pipeline crate in an
  isolated Rust harness. All frontend assertions and npm run build passed.
- Browser tests checked matrix selection, normalization, grade/basis switching,
  exact sample keys and the self-contained preview.
- Patch applies on a clean base checkout; resulting files were compared bytewise.

Native acceptance test (normal DuckDB runtime required):

```sh
cargo test -p dwh-host --test mapping_quality
npx tsx src/lib/mappingQuality.test.ts
```

Full cargo check -p dwh-host --tests was blocked here by the existing libduckdb-sys
prebuilt download (Connection refused). The native test is supplied but not
claimed executed. An end-to-end Electron session with the real host still needs
local acceptance. No new dependencies or Cargo.lock/package-lock changes.

This is a lab-schema prototype, not universal mapping profiling. Chart data is
bounded, but the existing seed workspace/SQL transport still includes all mapping
rows. New mapping cardinalities and real LLM integration are outside this patch.

GitHub write access was denied by the integration in this session. No branch or
PR has been published; this archive contains the complete implementation.
